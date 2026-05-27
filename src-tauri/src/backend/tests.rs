use super::*;
    use std::fs::{File, OpenOptions};
    use tempfile::TempDir;

    const MB: u64 = 1024 * 1024;

    fn build_test_state() -> (TempDir, SharedState) {
        let temp_dir = TempDir::new().expect("failed to create temp directory");
        let capture_dir = temp_dir.path().join("captures");
        let backup_dir = temp_dir.path().join("backups");
        fs::create_dir_all(&capture_dir).expect("failed to create capture directory");
        fs::create_dir_all(&backup_dir).expect("failed to create backup directory");

        let db_path = temp_dir.path().join("memorylane-test.db");
        let conn = Connection::open(&db_path).expect("failed to open test sqlite db");
        initialize_database(&conn).expect("failed to initialize test db schema");

        let settings = read_settings(&conn).expect("failed to read default settings");

        let state = SharedState {
            db: Arc::new(Mutex::new(conn)),
            capture_dir,
            backup_dir,
            pause_state: Arc::new(AtomicBool::new(settings.is_paused)),
            consecutive_capture_failures: Arc::new(AtomicU32::new(0)),
            last_capture_error: Arc::new(Mutex::new(None)),
            allow_exit: Arc::new(AtomicBool::new(false)),
            indexing_epoch: Arc::new(AtomicU64::new(0)),
            search_cache: Arc::new(Mutex::new(HashMap::new())),
            intelligence_cache: Arc::new(Mutex::new(HashMap::new())),
            performance_stats: Arc::new(Mutex::new(PerformanceStats::default())),
        };

        (temp_dir, state)
    }

    fn create_file_with_size(path: &Path, size: u64) -> Result<(), String> {
        let file = File::create(path)
            .map_err(|error| format!("failed to create test file {}: {error}", path.display()))?;
        file.set_len(size)
            .map_err(|error| format!("failed to resize test file {}: {error}", path.display()))
    }

    fn insert_fake_capture(
        state: &SharedState,
        day_key: &str,
        stem: &str,
        image_size: u64,
        thumb_size: u64,
    ) -> Result<(), String> {
        let day_dir = state.capture_dir.join(day_key);
        fs::create_dir_all(&day_dir)
            .map_err(|error| format!("failed to create day directory {}: {error}", day_dir.display()))?;

        let image_path = day_dir.join(format!("{stem}.png"));
        let thumb_path = day_dir.join(format!("{stem}_thumb.jpg"));

        create_file_with_size(&image_path, image_size)?;
        create_file_with_size(&thumb_path, thumb_size)?;

        let captured_at = format!("{day_key}T09:00:00+00:00");

        with_connection(state, |conn| {
            conn.execute(
                "
                INSERT INTO captures (day_key, captured_at, image_path, thumbnail_path, width, height)
                VALUES (?, ?, ?, ?, ?, ?)
                ",
                params![
                    day_key,
                    captured_at,
                    image_path.to_string_lossy().to_string(),
                    thumb_path.to_string_lossy().to_string(),
                    1920_i64,
                    1080_i64
                ],
            )
            .map_err(|error| format!("failed to insert fake capture row: {error}"))?;

            let capture_id = conn.last_insert_rowid();
            ensure_capture_annotation_row(conn, capture_id)?;

            Ok(())
        })
    }

    fn set_settings_for_test(
        state: &SharedState,
        retention_days: i64,
        storage_cap_gb: f64,
    ) -> Result<(), String> {
        with_connection(state, |conn| {
            let mut settings = read_settings(conn)?;
            settings.retention_days = retention_days;
            settings.storage_cap_gb = storage_cap_gb;
            write_settings(conn, &settings)
        })
    }

    fn read_day_keys(state: &SharedState) -> Result<Vec<String>, String> {
        with_connection(state, |conn| {
            let mut stmt = conn
                .prepare("SELECT DISTINCT day_key FROM captures ORDER BY day_key ASC")
                .map_err(|error| format!("failed to prepare day key query: {error}"))?;

            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("failed to run day key query: {error}"))?;

            let mut keys = Vec::new();
            for row in rows {
                keys.push(row.map_err(|error| format!("failed to read day key row: {error}"))?);
            }

            Ok(keys)
        })
    }

    fn resize_day_files(state: &SharedState, day_key: &str, image_size: u64, thumb_size: u64) -> Result<(), String> {
        let paths = with_connection(state, |conn| {
            let mut stmt = conn
                .prepare("SELECT image_path, thumbnail_path FROM captures WHERE day_key = ?")
                .map_err(|error| format!("failed to prepare resize path query: {error}"))?;

            let rows = stmt
                .query_map(params![day_key], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("failed to run resize path query: {error}"))?;

            let mut result = Vec::new();
            for row in rows {
                result.push(row.map_err(|error| format!("failed to read resize path row: {error}"))?);
            }

            Ok(result)
        })?;

        for (image_path, thumb_path) in paths {
            let image_file = OpenOptions::new()
                .write(true)
                .open(&image_path)
                .map_err(|error| format!("failed to open image for resize {}: {error}", image_path))?;
            image_file
                .set_len(image_size)
                .map_err(|error| format!("failed to resize image {}: {error}", image_path))?;

            let thumb_file = OpenOptions::new()
                .write(true)
                .open(&thumb_path)
                .map_err(|error| format!("failed to open thumbnail for resize {}: {error}", thumb_path))?;
            thumb_file
                .set_len(thumb_size)
                .map_err(|error| format!("failed to resize thumbnail {}: {error}", thumb_path))?;
        }

        Ok(())
    }

    fn read_capture_ids_for_day(state: &SharedState, day_key: &str) -> Result<Vec<i64>, String> {
        with_connection(state, |conn| {
            let mut stmt = conn
                .prepare("SELECT id FROM captures WHERE day_key = ? ORDER BY captured_at ASC")
                .map_err(|error| format!("failed to prepare capture id query: {error}"))?;

            let rows = stmt
                .query_map(params![day_key], |row| row.get::<_, i64>(0))
                .map_err(|error| format!("failed to run capture id query: {error}"))?;

            let mut ids = Vec::new();
            for row in rows {
                ids.push(row.map_err(|error| format!("failed to read capture id row: {error}"))?);
            }

            Ok(ids)
        })
    }

    #[test]
    fn fresh_install_uses_empty_theme_for_onboarding() {
        let connection = Connection::open_in_memory().expect("failed to open in-memory sqlite db");
        initialize_database(&connection).expect("failed to initialize fresh db schema");

        let settings = read_settings(&connection).expect("failed to read settings for fresh install");
        assert_eq!(settings.theme_id, "");
    }

    #[test]
    fn legacy_install_gets_seeded_with_amber_theme() {
        let connection = Connection::open_in_memory().expect("failed to open in-memory sqlite db");
        connection
            .execute_batch(
                "
                CREATE TABLE settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    interval_minutes INTEGER NOT NULL,
                    retention_days INTEGER NOT NULL,
                    storage_cap_gb REAL NOT NULL,
                    is_paused INTEGER NOT NULL
                );

                CREATE TABLE captures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day_key TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    image_path TEXT NOT NULL,
                    thumbnail_path TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                );

                INSERT INTO settings (id, interval_minutes, retention_days, storage_cap_gb, is_paused)
                VALUES (1, 2, 30, 5.0, 0);
                ",
            )
            .expect("failed to seed legacy schema");

        initialize_database(&connection).expect("failed to migrate legacy schema");

        let settings = read_settings(&connection).expect("failed to read migrated settings");
        assert_eq!(settings.theme_id, LEGACY_THEME_ID);
    }

    #[test]
    fn initialize_database_backfills_capture_search_rows() {
        let connection = Connection::open_in_memory().expect("failed to open in-memory sqlite db");
        connection
            .execute_batch(
                "
                CREATE TABLE settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    interval_minutes INTEGER NOT NULL,
                    retention_days INTEGER NOT NULL,
                    storage_cap_gb REAL NOT NULL,
                    is_paused INTEGER NOT NULL
                );

                CREATE TABLE captures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day_key TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    image_path TEXT NOT NULL,
                    thumbnail_path TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                );

                INSERT INTO settings (id, interval_minutes, retention_days, storage_cap_gb, is_paused)
                VALUES (1, 2, 30, 5.0, 0);

                INSERT INTO captures (day_key, captured_at, image_path, thumbnail_path, width, height)
                VALUES ('2026-04-19', '2026-04-19T08:00:00+00:00', 'a.jpg', 'a_thumb.jpg', 1920, 1080);
                ",
            )
            .expect("failed to seed legacy schema");

        initialize_database(&connection).expect("failed to migrate legacy schema");

        let indexed_count = connection
            .query_row("SELECT COUNT(*) FROM capture_search_index", [], |row| row.get::<_, i64>(0))
            .expect("failed to count capture_search_index rows");

        assert_eq!(indexed_count, 1);
    }

    #[test]
    fn initialize_database_adds_window_metadata_columns() {
        let connection = Connection::open_in_memory().expect("failed to open in-memory sqlite db");
        connection
            .execute_batch(
                "
                CREATE TABLE settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    interval_minutes INTEGER NOT NULL,
                    retention_days INTEGER NOT NULL,
                    storage_cap_gb REAL NOT NULL,
                    is_paused INTEGER NOT NULL
                );

                CREATE TABLE captures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day_key TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    image_path TEXT NOT NULL,
                    thumbnail_path TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                );

                INSERT INTO settings (id, interval_minutes, retention_days, storage_cap_gb, is_paused)
                VALUES (1, 2, 30, 5.0, 0);
                ",
            )
            .expect("failed to seed legacy schema");

        initialize_database(&connection).expect("failed to migrate legacy schema");

        let mut stmt = connection
            .prepare("PRAGMA table_info(captures)")
            .expect("failed to prepare table info query");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("failed to execute table info query");

        let mut columns = Vec::new();
        for row in rows {
            columns.push(row.expect("failed to read table info row"));
        }

        assert!(columns.contains(&"window_title".to_string()));
        assert!(columns.contains(&"process_name".to_string()));
    }

    #[test]
    fn parse_retrieval_time_hint_supports_yesterday_queries() {
        let parsed = parse_retrieval_time_hint("what was I doing around 3 PM yesterday");
        assert!(parsed.day_key.is_some());
        assert_eq!(parsed.target_minutes, Some(15 * 60));
    }

    #[test]
    fn parse_retrieval_query_parts_preserves_quoted_phrases() {
        let parsed = parse_retrieval_query_parts("\"release notes\" around 3 PM yesterday fix bug");
        assert!(parsed.phrases.contains(&"release notes".to_string()));
        assert!(parsed.terms.contains(&"fix".to_string()));
        assert!(parsed.terms.contains(&"bug".to_string()));
        assert!(!parsed.terms.contains(&"yesterday".to_string()));
    }

    #[test]
    fn parse_retrieval_query_parts_adds_implied_phrase_for_spaces() {
        let parsed = parse_retrieval_query_parts("release notes");
        assert!(parsed.phrases.contains(&"release notes".to_string()));
        assert!(parsed.terms.contains(&"release".to_string()));
        assert!(parsed.terms.contains(&"notes".to_string()));
    }

    #[test]
    fn parse_retrieval_query_parts_extracts_structured_filters() {
        let parsed = parse_retrieval_query_parts("app:figma window:design tag:roadmap bookmarked favorite");

        assert!(parsed.app_terms.contains(&"figma".to_string()));
        assert!(parsed.window_terms.contains(&"design".to_string()));
        assert!(parsed.tag_terms.contains(&"roadmap".to_string()));
        assert!(parsed.require_bookmarked);
        assert!(parsed.require_favorite);
    }

    #[test]
    fn evaluate_capture_policy_can_redact_sensitive_windows() {
        let settings = Settings {
            interval_minutes: 2,
            retention_days: 30,
            storage_cap_gb: 5.0,
            is_paused: false,
            startup_on_boot: false,
            theme_id: LEGACY_THEME_ID.to_string(),
            excluded_processes: Vec::new(),
            excluded_window_keywords: Vec::new(),
            pause_processes: Vec::new(),
            pause_window_keywords: Vec::new(),
            sensitive_window_keywords: vec!["bank".to_string()],
            sensitive_capture_mode: SensitiveCaptureMode::Redact,
        };

        let outcome = evaluate_capture_policy(&settings, "Online banking portal", "chrome.exe")
            .expect("expected redaction policy outcome");

        assert_eq!(outcome.mode, "redact");
        assert!(outcome.captured);
    }

    #[test]
    fn build_retrieval_snippet_uses_window_metadata_when_available() {
        let query_parts = parse_retrieval_query_parts("figma");
        let snippet = build_retrieval_snippet(
            "",
            "",
            "Figma - Design System",
            "figma.exe",
            &[],
            false,
            false,
            &query_parts,
            "fallback",
        );

        assert_eq!(snippet.source, "window");
        assert!(snippet.snippet.to_ascii_lowercase().contains("window:"));
        assert!(snippet
            .highlight_terms
            .iter()
            .any(|term| term.to_ascii_lowercase() == "figma"));
    }

    #[test]
    fn backup_crypto_round_trip_returns_original_payload() {
        let plaintext = br#"{"version":1,"captureCount":3}"#;
        let encrypted = encrypt_backup_payload("correct horse battery staple", plaintext)
            .expect("failed to encrypt payload for roundtrip test");
        let decrypted = decrypt_backup_payload("correct horse battery staple", &encrypted)
            .expect("failed to decrypt payload for roundtrip test");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn day_intelligence_builds_focus_blocks_and_terms() {
        let day_key = "2026-04-19";
        let rows = vec![
            (
                "2026-04-19T09:00:00+00:00".to_string(),
                "reviewed api docs".to_string(),
                "opened api reference".to_string(),
            ),
            (
                "2026-04-19T09:06:00+00:00".to_string(),
                "fixed auth bug".to_string(),
                "auth token flow".to_string(),
            ),
            (
                "2026-04-19T10:02:00+00:00".to_string(),
                "updated release notes".to_string(),
                "changelog release prep".to_string(),
            ),
        ];

        let payload = build_day_intelligence_payload(day_key, &rows, 12);
        assert_eq!(payload.day_key, day_key);
        assert_eq!(payload.focus_blocks.len(), 2);
        assert!(!payload.summary.is_empty());
        assert!(!payload.top_terms.is_empty());
        assert!(!payload.change_highlights.is_empty());
    }

    #[test]
    fn delete_day_removes_files_and_rows_consistently() {
        let (_temp_dir, state) = build_test_state();

        insert_fake_capture(&state, "2026-04-10", "a01", 2 * MB, MB).expect("insert first capture failed");
        insert_fake_capture(&state, "2026-04-10", "a02", 2 * MB, MB).expect("insert second capture failed");
        insert_fake_capture(&state, "2026-04-11", "b01", 2 * MB, MB).expect("insert third capture failed");

        let payload = delete_day_internal(&state, "2026-04-10").expect("delete day internal failed");
        assert_eq!(payload.removed_rows, 2);
        assert_eq!(payload.removed_files, 4);

        let remaining_days = read_day_keys(&state).expect("failed to read remaining day keys");
        assert_eq!(remaining_days, vec!["2026-04-11".to_string()]);

        assert!(!state.capture_dir.join("2026-04-10").exists());
        assert!(state.capture_dir.join("2026-04-11").exists());
    }

    #[test]
    fn delete_capture_removes_files_and_cleans_empty_day_directory() {
        let (_temp_dir, state) = build_test_state();

        insert_fake_capture(&state, "2026-04-12", "x01", MB, MB).expect("insert first capture failed");
        insert_fake_capture(&state, "2026-04-12", "x02", MB, MB).expect("insert second capture failed");

        let ids = read_capture_ids_for_day(&state, "2026-04-12").expect("failed to read inserted capture ids");
        assert_eq!(ids.len(), 2);

        let first_delete =
            delete_capture_internal(&state, ids[0]).expect("failed deleting first capture in day");
        assert_eq!(first_delete.removed_files, 2);
        assert_eq!(first_delete.day_key, "2026-04-12".to_string());

        let remaining_after_first =
            read_capture_ids_for_day(&state, "2026-04-12").expect("failed reading captures after first delete");
        assert_eq!(remaining_after_first.len(), 1);
        assert!(state.capture_dir.join("2026-04-12").exists());

        let second_delete =
            delete_capture_internal(&state, ids[1]).expect("failed deleting final capture in day");
        assert_eq!(second_delete.removed_files, 2);

        let remaining_after_second =
            read_capture_ids_for_day(&state, "2026-04-12").expect("failed reading captures after second delete");
        assert!(remaining_after_second.is_empty());
        assert!(!state.capture_dir.join("2026-04-12").exists());
    }

    #[test]
    fn retention_purge_respects_age_and_storage_cap() {
        let (_temp_dir, state) = build_test_state();

        let old_day = (Local::now() - chrono::Duration::days(3)).format("%Y-%m-%d").to_string();
        let mid_day = (Local::now() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        let new_day = Local::now().format("%Y-%m-%d").to_string();

        insert_fake_capture(&state, &old_day, "d1", MB, MB).expect("insert old day capture failed");
        insert_fake_capture(&state, &mid_day, "d2", MB, MB).expect("insert middle day capture failed");
        insert_fake_capture(&state, &new_day, "d3", MB, MB).expect("insert newest day capture failed");

        set_settings_for_test(&state, 2, 100.0).expect("failed to set age-based retention settings");
        apply_retention_rules(&state).expect("age-based retention purge failed");

        let after_age_purge = read_day_keys(&state).expect("failed to read day keys after age purge");
        assert_eq!(after_age_purge, vec![mid_day.clone(), new_day.clone()]);

        resize_day_files(&state, &mid_day, 320 * MB, 4 * MB).expect("failed to resize middle day files");
        resize_day_files(&state, &new_day, 320 * MB, 4 * MB).expect("failed to resize newest day files");

        set_settings_for_test(&state, 365, 0.5).expect("failed to set storage-cap retention settings");
        apply_retention_rules(&state).expect("storage-cap retention purge failed");

        let after_cap_purge = read_day_keys(&state).expect("failed to read day keys after cap purge");
        assert_eq!(after_cap_purge, vec![new_day.clone()]);
        assert!(!state.capture_dir.join(mid_day).exists());
        assert!(state.capture_dir.join(new_day).exists());
    }
