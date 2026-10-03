use super::*;
use crate::backend::tests::{build_test_state, insert_fake_capture, set_settings_for_test};

fn restart(temp: &tempfile::TempDir, state: &SharedState) -> SharedState {
    let conn = Connection::open(temp.path().join("memorylane-test.db")).unwrap();
    initialize_database(&conn).unwrap();
    SharedState {
        db: Arc::new(Mutex::new(conn)),
        ..state.clone()
    }
}
fn id(state: &SharedState) -> i64 {
    with_connection(state, |conn| {
        conn.query_row("SELECT id FROM captures ORDER BY id LIMIT 1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())
    })
    .unwrap()
}
fn count(state: &SharedState, table: &str) -> i64 {
    with_connection(state, |conn| {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| e.to_string())
    })
    .unwrap()
}

#[test]
fn migration_repairs_orphans_enforces_foreign_keys_and_preserves_library() {
    let conn = Connection::open_in_memory().unwrap();
    super::super::initialize_database_v1(&conn).unwrap();
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    conn.execute_batch("INSERT INTO captures(id,day_key,captured_at,image_path,thumbnail_path,width,height,capture_note)
        VALUES(17,'2026-10-03','now','image','thumb',10,10,'keep note');
        INSERT INTO capture_search_index(capture_id,ocr_text,search_text,ocr_status) VALUES(17,'OCR','search','ready'),(999,'orphan','','ready');
        INSERT INTO capture_annotations(capture_id,is_bookmarked,tags) VALUES(17,1,'[\"keep\"]'),(999,1,'[]');").unwrap();
    initialize_database(&conn).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM capture_annotations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT ocr_text FROM capture_search_index WHERE capture_id=17",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "OCR"
    );
    assert_eq!(
        conn.query_row(
            "SELECT tags FROM capture_annotations WHERE capture_id=17",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "[\"keep\"]"
    );
    assert!(conn
        .execute(
            "INSERT INTO capture_annotations(capture_id) VALUES(999)",
            []
        )
        .is_err());
    assert!(!conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    let token: String = conn
        .query_row("SELECT content_token FROM captures WHERE id=17", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(token.len(), 32);
    initialize_database(&conn).unwrap();
    assert_eq!(
        token,
        conn.query_row("SELECT content_token FROM captures WHERE id=17", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap()
    );
    conn.execute("DELETE FROM captures WHERE id=17", [])
        .unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM capture_search_index", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn schema_failure_rolls_back_and_newer_schema_is_refused() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE captures(id INTEGER PRIMARY KEY);")
        .unwrap();
    assert!(initialize_database(&conn).is_err());
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!conn
        .prepare("SELECT name FROM sqlite_master WHERE name='settings'")
        .unwrap()
        .exists([])
        .unwrap());
    conn.pragma_update(None, "user_version", 100).unwrap();
    assert!(initialize_database(&conn)
        .unwrap_err()
        .contains("Unsupported archive schema"));
}

#[test]
fn metadata_and_image_redaction_advance_durable_versions_and_reused_ids_get_new_tokens() {
    let (_temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-10-03", "revision", 9, 3).unwrap();
    let capture = id(&state);
    let read = || {
        with_connection(&state, |conn| {
            conn.query_row(
                "SELECT content_revision,content_token FROM captures WHERE id=?",
                params![capture],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(|e| e.to_string())
        })
        .unwrap()
    };
    let initial = read();
    with_connection(&state, |conn| {
        conn.execute(
            "UPDATE captures SET window_title='[redacted]',process_name='[redacted]' WHERE id=?",
            params![capture],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .unwrap();
    let metadata = read();
    assert!(metadata.0 > initial.0);
    assert_ne!(metadata.1, initial.1);
    with_connection(&state, |conn| touch_content(conn, capture)).unwrap();
    let pixels = read();
    assert!(pixels.0 > metadata.0);
    assert_ne!(pixels.1, metadata.1);
    with_connection(&state,|conn| {conn.execute("DELETE FROM captures WHERE id=?",params![capture]).map_err(|e|e.to_string())?;
        conn.execute("INSERT INTO captures(id,day_key,captured_at,image_path,thumbnail_path,width,height) VALUES(?,'2026-10-03','now','a','b',1,1)",params![capture]).map_err(|e|e.to_string())?;Ok(())}).unwrap();
    assert_ne!(read().1, pixels.1);
}

#[test]
fn failed_logical_delete_rolls_back_visibility_and_cleanup_leases() {
    let (_temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-10-03", "first", 10, 5).unwrap();
    insert_fake_capture(&state, "2026-10-03", "second", 20, 5).unwrap();
    with_connection(&state,|conn|conn.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON captures WHEN OLD.id=2 BEGIN SELECT RAISE(ABORT,'injected'); END;").map_err(|e|e.to_string())).unwrap();
    assert!(delete_day_internal(&state, "2026-10-03").is_err());
    assert_eq!(count(&state, "captures"), 2);
    assert_eq!(count(&state, "capture_annotations"), 2);
    assert_eq!(
        get_storage_stats_internal(&state)
            .unwrap()
            .pending_cleanup_count,
        0
    );
    assert_eq!(get_storage_stats_internal(&state).unwrap().used_bytes, 40);
    assert!(state.capture_dir.join("2026-10-03/first.png").exists());
}

#[cfg(windows)]
fn lock_file(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .unwrap()
}

#[cfg(windows)]
#[test]
fn windows_locked_deletion_survives_restart_and_accounts_pending_bytes() {
    let (temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-10-03", "locked", 100, 20).unwrap();
    let image = state.capture_dir.join("2026-10-03/locked.png");
    let locked = lock_file(&image);
    let payload = delete_capture_internal(&state, id(&state)).unwrap();
    assert_eq!(payload.removed_files, 1);
    assert_eq!(count(&state, "captures"), 0);
    let stats = get_storage_stats_internal(&state).unwrap();
    assert_eq!(
        (
            stats.used_bytes,
            stats.pending_cleanup_bytes,
            stats.pending_cleanup_count
        ),
        (100, 100, 1)
    );
    assert!(stats.last_storage_error.is_some());
    let reopened = restart(&temp, &state);
    reconcile(&reopened).unwrap();
    let attempts = with_connection(&reopened, |conn| {
        conn.query_row("SELECT attempts FROM managed_files", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())
    })
    .unwrap();
    assert_eq!(attempts, 1, "startup preserves retry backoff");
    assert_eq!(cleanup(&reopened, false, CLEANUP_BATCH).unwrap(), 0);
    drop(locked);
    assert_eq!(cleanup(&reopened, true, CLEANUP_BATCH).unwrap(), 1);
    assert!(!image.exists());
    assert_eq!(get_storage_stats_internal(&reopened).unwrap().used_bytes, 0);
    assert_eq!(count(&reopened, "managed_files"), 0);
}

#[test]
fn interrupted_capture_leases_recover_partial_outputs_and_preserve_unrelated_files() {
    let (temp, state) = build_test_state();
    let day = state.capture_dir.join("2026-10-03");
    fs::create_dir(&day).unwrap();
    let partial = day.join("unique_partial.jpg");
    let mut pending = PendingCaptureFiles::new(&state);
    pending.write(&partial, &[1, 2, 3, 4, 5, 6]).unwrap();
    std::mem::forget(pending); // Process stopped after write, before the capture transaction.
    fs::OpenOptions::new()
        .write(true)
        .open(&partial)
        .unwrap()
        .set_len(3)
        .unwrap();
    let reserved = day.join("unique_reserved.jpg");
    with_connection(&state, |conn| {
        record_file(conn, &reserved, 0, "staging", None)
    })
    .unwrap();
    fs::write(&reserved, [1, 2]).unwrap(); // Process stopped between create_new and identity journaling.
    let unrelated = day.join("personal.txt");
    fs::write(&unrelated, [0; 7]).unwrap();
    let reopened = restart(&temp, &state);
    reconcile(&reopened).unwrap();
    let stats = get_storage_stats_internal(&reopened).unwrap();
    assert_eq!(
        (
            stats.used_bytes,
            stats.pending_cleanup_bytes,
            stats.untracked_bytes
        ),
        (12, 5, 7)
    );
    assert_eq!(cleanup(&reopened, true, CLEANUP_BATCH).unwrap(), 2);
    assert!(!partial.exists());
    assert!(!reserved.exists());
    assert!(unrelated.exists());
    assert_eq!(get_storage_stats_internal(&reopened).unwrap().used_bytes, 7);
}

#[test]
fn imported_reused_paths_and_ids_defeat_old_deletion_leases() {
    let (_temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-10-03", "reuse", 10, 5).unwrap();
    let capture = id(&state);
    let _gate = gate(&state);
    delete_rows(&state, None, Some(capture)).unwrap();
    let image = state.capture_dir.join("2026-10-03/reuse.png");
    let thumb = state.capture_dir.join("2026-10-03/reuse_thumb.jpg");
    fs::remove_file(&image).unwrap();
    fs::write(&image, [8; 30]).unwrap();
    with_connection(&state,|conn| {
        conn.execute("INSERT INTO captures(id,day_key,captured_at,image_path,thumbnail_path,width,height) VALUES(?,'2026-10-03','new',?,?,1,1)",
            params![capture,image.to_string_lossy(),thumb.to_string_lossy()]).map_err(|e|e.to_string())?;Ok(())
    }).unwrap();
    after_import(&state).unwrap();
    reconcile(&state).unwrap();
    assert_eq!(cleanup(&state, true, CLEANUP_BATCH).unwrap(), 0);
    assert_eq!(fs::read(&image).unwrap(), vec![8; 30]);
    assert_eq!(
        get_storage_stats_internal(&state)
            .unwrap()
            .pending_cleanup_count,
        0
    );
    assert_eq!(get_storage_stats_internal(&state).unwrap().used_bytes, 35);
}

#[test]
fn restore_preflight_preserves_untracked_files_and_folders_before_any_rows_change() {
    let (_temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-10-03", "live", 10, 5).unwrap();
    let _gate = gate(&state);
    validate_restore_cleanup(&state).unwrap();
    let unknown = state.capture_dir.join("personal.txt");
    fs::write(&unknown, b"keep").unwrap();
    assert!(validate_restore_cleanup(&state).is_err());
    assert_eq!(count(&state, "captures"), 1);
    assert_eq!(fs::read(&unknown).unwrap(), b"keep");
    fs::remove_file(&unknown).unwrap();
    let folder = state.capture_dir.join("personal-folder");
    fs::create_dir(&folder).unwrap();
    assert!(validate_restore_cleanup(&state).is_err());
    assert!(folder.exists());
    assert!(state.capture_dir.join("2026-10-03/live.png").exists());
}

#[test]
fn stats_use_persisted_counters_without_touching_capture_tree() {
    let (temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-10-03", "counter", 120, 30).unwrap();
    let moved = temp.path().join("offline-captures");
    fs::rename(&state.capture_dir, &moved).unwrap();
    let stats = get_storage_stats_internal(&state).unwrap();
    assert_eq!((stats.used_bytes, stats.capture_count), (150, 1));
    fs::rename(&moved, &state.capture_dir).unwrap();
}

#[test]
fn archive_ownership_prevents_a_second_process_from_reaping_active_capture_leases() {
    let temp = tempfile::TempDir::new().unwrap();
    let owner = lock_archive(temp.path()).unwrap();
    assert!(lock_archive(temp.path()).is_err());
    drop(owner);
    assert!(
        lock_archive(temp.path()).is_ok(),
        "the OS releases ownership after the process closes its handle"
    );
}

#[test]
fn shutdown_preserves_unfinished_cleanup_for_next_startup() {
    let (_temp, state) = build_test_state();
    let day = state.capture_dir.join("2026-10-03");
    fs::create_dir(&day).unwrap();
    let path = day.join("shutdown.jpg");
    fs::write(&path, [1; 9]).unwrap();
    with_connection(&state, |conn| {
        record_file(conn, &path, 9, "staging", Some(&identity(&path)?))
    })
    .unwrap();
    assert!(state.coordinator.start_shutdown());
    assert_eq!(cleanup(&state, true, CLEANUP_BATCH).unwrap(), 0);
    assert_eq!(count(&state, "managed_files"), 1);
    assert!(path.exists());
    assert!(reconcile(&state).is_err());
    assert!(!get_storage_stats_internal(&state).unwrap().accounting_ready);
}

#[test]
fn single_delete_does_not_purge_unrelated_day_content() {
    let (_temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-10-03", "one", 10, 5).unwrap();
    let unrelated = state.capture_dir.join("2026-10-03/keep.txt");
    fs::write(&unrelated, b"keep").unwrap();
    delete_capture_internal(&state, id(&state)).unwrap();
    assert!(unrelated.exists());
    reconcile(&state).unwrap();
    assert_eq!(
        get_storage_stats_internal(&state).unwrap().untracked_bytes,
        4
    );
}

#[cfg(windows)]
#[test]
fn cap_cleanup_terminates_when_locked_files_keep_usage_above_cap() {
    let (_temp, state) = build_test_state();
    let today = Local::now().format("%Y-%m-%d").to_string();
    let yesterday = (Local::now().date_naive() - chrono::Days::new(1))
        .format("%Y-%m-%d")
        .to_string();
    insert_fake_capture(&state, &today, "today", 300 * 1024 * 1024, 10).unwrap();
    insert_fake_capture(&state, &yesterday, "old", 300 * 1024 * 1024, 10).unwrap();
    let a = lock_file(&state.capture_dir.join(&today).join("today.png"));
    let b = lock_file(&state.capture_dir.join(&yesterday).join("old.png"));
    set_settings_for_test(&state, 365, 0.5).unwrap();
    let _gate = gate(&state);
    assert!(retention(&state).unwrap());
    assert_eq!(count(&state, "captures"), 1);
    assert!(
        !retention(&state).unwrap(),
        "deleted days cannot be selected repeatedly"
    );
    let stats = get_storage_stats_internal(&state).unwrap();
    assert_eq!(stats.used_bytes, 600 * 1024 * 1024 + 10);
    assert_eq!(stats.pending_cleanup_count, 1);
    assert_eq!(stats.pending_cleanup_bytes, 300 * 1024 * 1024);
    drop(a);
    drop(b);
    cleanup(&state, true, CLEANUP_BATCH).unwrap();
    assert_eq!(
        get_storage_stats_internal(&state).unwrap().used_bytes,
        300 * 1024 * 1024 + 10
    );
}

#[test]
fn imported_limits_and_old_history_are_enforced_while_paused() {
    let (_temp, state) = build_test_state();
    insert_fake_capture(&state, "2020-01-01", "old", 20, 5).unwrap();
    let mut core = state.coordinator.lock();
    let mut settings = core.settings.clone();
    settings.is_paused = true;
    core.apply_settings(settings, Instant::now());
    drop(core);
    after_import(&state).unwrap();
    let work = state.coordinator.wait_next().unwrap();
    assert_eq!(work.ticket.intent, coordinator::CaptureIntent::Maintenance);
    assert!(maintenance(&state, state.coordinator.take_reconciliation()).unwrap());
    state
        .coordinator
        .lock()
        .finish(&work.ticket, Instant::now());
    assert_eq!(count(&state, "captures"), 0);
    assert_eq!(get_storage_stats_internal(&state).unwrap().used_bytes, 0);
    assert!(state.coordinator.snapshot().is_paused);
}

#[test]
fn partial_retention_failure_still_invalidates_removed_content_and_reports_the_error() {
    let (temp, state) = build_test_state();
    insert_fake_capture(&state, "2020-01-01", "valid", 10, 5).unwrap();
    insert_fake_capture(&state, "2020-01-02", "poisoned", 10, 5).unwrap();
    let outside = temp.path().join("external.jpg");
    fs::write(&outside, b"keep").unwrap();
    with_connection(&state, |conn| {
        conn.execute("UPDATE storage_accounting SET reconciled=1 WHERE id=1", [])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE captures SET image_path=? WHERE day_key='2020-01-02'",
            params![outside.to_string_lossy()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .unwrap();
    assert!(run_maintenance(&state, false));
    assert_eq!(count(&state, "captures"), 1);
    assert!(get_storage_stats_internal(&state)
        .unwrap()
        .last_storage_error
        .is_some());
    assert_eq!(fs::read(outside).unwrap(), b"keep");
}

#[test]
fn synthetic_storage_work_comparison() {
    for captures in [100usize, 2000usize] {
        let (_temp, state) = build_test_state();
        let today = Local::now().format("%Y-%m-%d").to_string();
        let day = state.capture_dir.join(&today);
        fs::create_dir(&day).unwrap();
        let mut paths = Vec::new();
        for n in 0..captures {
            let image = day.join(format!("{n}.jpg"));
            let thumb = day.join(format!("{n}_thumb.jpg"));
            fs::write(&image, [0; 128]).unwrap();
            fs::write(&thumb, [0; 64]).unwrap();
            paths.push((image, thumb));
        }
        with_connection(&state,|conn| {
            let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
            for (image,thumb) in paths {
                tx.execute("INSERT INTO captures(day_key,captured_at,image_path,thumbnail_path,width,height) VALUES(?,'now',?,?,1,1)",
                    params![today,image.to_string_lossy(),thumb.to_string_lossy()]).map_err(|e|e.to_string())?;
            }
            tx.commit().map_err(|e|e.to_string())
        }).unwrap();
        let started = Instant::now();
        let files = reconcile(&state).unwrap();
        let reconciliation = started.elapsed();
        assert_eq!(files, captures * 2);
        let mut persisted = Vec::new();
        for _ in 0..100 {
            let started = Instant::now();
            let stats = get_storage_stats_internal(&state).unwrap();
            persisted.push(started.elapsed().as_micros());
            assert_eq!(stats.used_bytes, (captures * 192) as u64);
            assert_eq!(stats.capture_count, captures as i64);
        }
        let mut scans = Vec::new();
        for _ in 0..10 {
            let started = Instant::now();
            assert_eq!(
                directory_size(&state.capture_dir).unwrap(),
                (captures * 192) as u64
            );
            scans.push(started.elapsed().as_micros());
        }
        let started = Instant::now();
        for id in 1..=10 {
            delete_capture_internal(&state, id).unwrap();
        }
        let cleanup_time = started.elapsed();
        assert_eq!(
            get_storage_stats_internal(&state).unwrap().used_bytes,
            ((captures - 10) * 192) as u64
        );
        persisted.sort();
        scans.sort();
        println!("STORAGE_BENCH captures={captures} files={files} bytes={} reconcile_ms={} stats_median_us={} old_tree_scan_median_us={} delete_10_ms={}",
            captures*192,reconciliation.as_millis(),persisted[50],scans[5],cleanup_time.as_millis());
    }
}
