use super::*;

fn fixture_desktop() -> privacy::PrivacySnapshot {
    privacy::PrivacySnapshot { monitor: 1, bounds: (0, 0, 1920, 1080), foreground: 1, secure: false, epoch: 0,
        windows: vec![privacy::VisibleWindow { handle: 1, rect: (0,0,1920,1080), title: "secret".into(), process: "fixture.exe".into(), title_known: true, process_known: true }] }
}

fn fixture_frame() -> Result<capture::CaptureOutcome, String> {
    Ok(capture::CaptureOutcome::Frame(image::RgbaImage::from_pixel(32,32,image::Rgba([100,100,100,255]))))
}

fn fixture_capture_count(state: &SharedState) -> i64 {
    with_connection(state, |conn| conn.query_row("SELECT COUNT(*) FROM captures", [], |row| row.get(0)).map_err(|e| e.to_string())).unwrap()
}

#[test]
fn pause_acknowledges_during_acquisition_then_discards_all_outputs() {
    let (_temp, state) = build_test_state();
    let ticket = state.coordinator.lock().next(Instant::now()).unwrap().ticket;
    let worker_state = state.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || capture_once_with(&worker_state, &ticket, None, || Ok(fixture_desktop()), || {
        started_tx.send(()).unwrap(); release_rx.recv().unwrap(); fixture_frame()
    }));
    started_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    set_pause_internal(&state, true, None).unwrap();
    assert!(state.coordinator.snapshot().is_paused);
    assert!(with_connection(&state, read_settings).unwrap().is_paused);
    release_tx.send(()).unwrap();
    assert!(matches!(worker.join().unwrap().unwrap(), CaptureRunResult::Suppressed(_)));
    assert_eq!(fixture_capture_count(&state), 0);
    assert_eq!(directory_size(&state.capture_dir).unwrap(), 0);
    assert_eq!(fs::read_dir(&state.capture_dir).unwrap().count(), 0);
}

#[test]
fn pause_immediately_before_persistence_and_privacy_edits_discard_captures() {
    for change_privacy in [false, true] {
        let (_temp, state) = build_test_state();
        let ticket = state.coordinator.lock().next(Instant::now()).unwrap().ticket;
        let mut inspections = 0;
        let result = capture_once_with(&state, &ticket, None, || {
            inspections += 1;
            if inspections == 3 {
                if change_privacy {
                    let mut core = state.coordinator.lock();
                    let mut settings = core.settings.clone(); settings.excluded_processes.push("fixture.exe".into());
                    apply_recording_settings_locked(&state, &mut core, settings);
                } else { set_pause_internal(&state, true, None).unwrap(); }
            }
            Ok(fixture_desktop())
        }, fixture_frame).unwrap();
        assert!(matches!(result, CaptureRunResult::Suppressed(_)));
        assert_eq!(fixture_capture_count(&state), 0);
        assert_eq!(directory_size(&state.capture_dir).unwrap(), 0);
        assert_eq!(fs::read_dir(&state.capture_dir).unwrap().count(), 0);
    }
}

#[test]
fn desktop_or_secure_context_changes_cannot_persist_acquired_pixels() {
    for secure in [false, true] {
        let (_temp, state) = build_test_state();
        let ticket = state.coordinator.lock().next(Instant::now()).unwrap().ticket;
        let mut inspections = 0;
        let result = capture_once_with(&state, &ticket, None, || {
            inspections += 1;
            let mut desktop = fixture_desktop();
            if inspections > 1 { desktop.secure = secure; desktop.epoch += 1; }
            Ok(desktop)
        }, fixture_frame).unwrap();
        assert!(matches!(result, CaptureRunResult::Suppressed(_)));
        assert_eq!(fixture_capture_count(&state), 0);
        assert_eq!(directory_size(&state.capture_dir).unwrap(), 0);
    }
}

#[test]
fn cosmetic_desktop_churn_during_capture_still_saves() {
    let (_temp, state) = build_test_state();
    let ticket = state.coordinator.lock().next(Instant::now()).unwrap().ticket;
    let mut inspections = 0;
    let result = capture_once_with(&state, &ticket, None, || {
        inspections += 1;
        let mut desktop = fixture_desktop();
        // Live-updating titles, moves and focus changes must not abort a capture.
        desktop.windows[0].title = format!("secret {inspections}");
        desktop.windows[0].rect.0 += inspections;
        desktop.foreground = inspections as usize;
        Ok(desktop)
    }, fixture_frame).unwrap();
    assert!(matches!(result, CaptureRunResult::Captured));
    assert_eq!(fixture_capture_count(&state), 1);
}

#[test]
fn title_turning_sensitive_during_capture_discards_pixels() {
    let (_temp, state) = build_test_state();
    {
        let mut core = state.coordinator.lock();
        let mut settings = core.settings.clone(); settings.excluded_window_keywords = vec!["bank".into()];
        apply_recording_settings_locked(&state, &mut core, settings);
    }
    let ticket = state.coordinator.lock().next(Instant::now()).unwrap().ticket;
    let mut inspections = 0;
    let result = capture_once_with(&state, &ticket, None, || {
        inspections += 1;
        let mut desktop = fixture_desktop();
        if inspections > 1 { desktop.windows[0].title = "My Bank".into(); }
        Ok(desktop)
    }, fixture_frame).unwrap();
    assert!(matches!(result, CaptureRunResult::Suppressed(_)));
    assert_eq!(fixture_capture_count(&state), 0);
}


#[test]
fn failed_capture_transaction_removes_encoded_files_and_partial_rows() {
    let (_temp, state) = build_test_state();
    let ticket = state.coordinator.lock().next(Instant::now()).unwrap().ticket;
    with_connection(&state, |conn| {
        conn.execute_batch("CREATE TRIGGER fail_annotation BEFORE INSERT ON capture_annotations BEGIN SELECT RAISE(ABORT, 'injected'); END;").map_err(|e| e.to_string())
    }).unwrap();
    let result = capture_once_with(&state, &ticket, None, || Ok(fixture_desktop()), fixture_frame);
    assert!(result.is_err());
    assert_eq!(fixture_capture_count(&state), 0);
    assert_eq!(directory_size(&state.capture_dir).unwrap(), 0);
    with_connection(&state, |conn| {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM capture_search_index", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0); Ok(())
    }).unwrap();
}

#[test]
fn deliberate_manual_capture_while_paused_still_honors_redaction() {
    let (_temp, state) = build_test_state();
    set_pause_internal(&state, true, None).unwrap();
    {
        let mut core = state.coordinator.lock();
        let mut settings = core.settings.clone(); settings.sensitive_window_keywords = vec!["secret".into()];
        settings.sensitive_capture_mode = SensitiveCaptureMode::Redact;
        apply_recording_settings_locked(&state, &mut core, settings);
    }
    let _reply = state.coordinator.request_manual().unwrap();
    let ticket = state.coordinator.lock().next(Instant::now()).unwrap().ticket;
    let result = capture_once_with(&state, &ticket, None, || Ok(fixture_desktop()), fixture_frame).unwrap();
    assert!(matches!(result, CaptureRunResult::CapturedWithPolicy(_)));
    assert_eq!(fixture_capture_count(&state), 1);
    with_connection(&state, |conn| {
        let (path, title, process): (String,String,String) = conn.query_row("SELECT image_path, window_title, process_name FROM captures", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(title, "[redacted]"); assert_eq!(process, "[redacted]");
        let image = image::open(path).unwrap().to_rgb8();
        assert!(image.pixels().all(|p| p.0.iter().all(|v| *v < 15))); Ok(())
    }).unwrap();
    assert!(state.coordinator.snapshot().is_paused);
}

#[test]
fn pause_acknowledgement_serializes_with_persistence_and_publishes_consistent_state() {
    let (_temp, state) = build_test_state();
    let saving = state.coordinator.lock();
    let pause_state = state.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let pause = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        set_pause_internal(&pause_state, true, None).unwrap();
        finished_tx.send(()).unwrap();
    });
    started_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    assert!(finished_rx.try_recv().is_err());
    drop(saving);
    finished_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(); pause.join().unwrap();
    let published = state.coordinator.snapshot();
    assert!(published.is_paused && published.next_scheduled_attempt_at.is_none());
    assert!(with_connection(&state, read_settings).unwrap().is_paused);
    assert!(state.pause_state.load(Ordering::Acquire));
}

#[test]
fn pause_does_not_wait_for_storage_work_or_a_capture_waiting_for_storage() {
    let (_temp,state)=build_test_state();
    let storage_busy=storage::gate(&state);
    let ticket=state.coordinator.lock().next(Instant::now()).unwrap().ticket;
    let worker_state=state.clone();let (encoded_tx,encoded_rx)=std::sync::mpsc::channel();
    let worker=std::thread::spawn(move || {
        let mut inspections=0;
        capture_once_with(&worker_state,&ticket,None,|| {
            inspections+=1;
            if inspections==3 {encoded_tx.send(()).unwrap();}
            Ok(fixture_desktop())
        },fixture_frame)
    });
    encoded_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    let pause_state=state.clone();let (paused_tx,paused_rx)=std::sync::mpsc::channel();
    let pause=std::thread::spawn(move || {set_pause_internal(&pause_state,true,None).unwrap();paused_tx.send(()).unwrap();});
    // Filesystem maintenance may remain stalled. Pause has neither its gate nor a tree scan.
    paused_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    assert!(state.coordinator.recording_state().is_paused);
    drop(storage_busy);pause.join().unwrap();
    assert!(matches!(worker.join().unwrap().unwrap(),CaptureRunResult::Suppressed(_)));
    assert_eq!(fixture_capture_count(&state),0);
}

#[test]
fn shutdown_during_acquisition_discards_outputs_and_failure_allows_another_attempt() {
    let (_temp, state) = build_test_state();
    let first = state.coordinator.lock().next(Instant::now()).unwrap();
    assert!(capture_once_with(&state, &first.ticket, None, || Ok(fixture_desktop()), || Err("injected acquisition failure".into())).is_err());
    state.coordinator.lock().finish(&first.ticket, Instant::now());
    let _request = state.coordinator.request_manual().unwrap();
    let second = state.coordinator.lock().next(Instant::now()).unwrap();
    let result = capture_once_with(&state, &second.ticket, None, || Ok(fixture_desktop()), || {
        state.coordinator.shutdown(); fixture_frame()
    }).unwrap();
    assert!(matches!(result, CaptureRunResult::Suppressed(_)));
    assert_eq!(fixture_capture_count(&state), 0);
    assert_eq!(directory_size(&state.capture_dir).unwrap(), 0);
}

#[test]
fn a_panicking_database_capture_transaction_rolls_back_and_does_not_wedge_requests() {
    let (_temp, state) = build_test_state();
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<(), String> = with_connection(&state, |conn| {
            let transaction = conn.unchecked_transaction().unwrap();
            transaction.execute("INSERT INTO captures (day_key, captured_at, image_path, thumbnail_path, width, height) VALUES ('2026-04-12', 'fixture', 'missing', 'missing', 32, 32)", []).unwrap();
            panic!("injected capture transaction panic");
        });
    }));
    assert!(failure.is_err());
    assert_eq!(fixture_capture_count(&state), 0);
    assert!(!state.db.is_poisoned());
    set_pause_internal(&state, true, None).unwrap();
    assert!(state.coordinator.snapshot().is_paused);
}

#[test]
fn concurrent_tray_toggles_do_not_lose_a_recording_state_change() {
    let (_temp, state) = build_test_state();
    let ready = Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = (0..2).map(|_| {
        let state = state.clone(); let ready = ready.clone();
        std::thread::spawn(move || { ready.wait(); change_pause_internal(&state, None, None).unwrap(); })
    }).collect();
    ready.wait();
    for thread in threads { thread.join().unwrap(); }
    assert!(!state.coordinator.snapshot().is_paused);
    assert!(!with_connection(&state, read_settings).unwrap().is_paused);
    assert_eq!(state.coordinator.snapshot().generation, 2);
}

#[test]
fn unsafe_day_inputs_do_not_touch_files_or_rows() {
    let (temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-04-12", "keep", 8, 4).unwrap();
    let sentinel = temp.path().join("sentinel.txt");
    fs::write(&sentinel, "outside").unwrap();
    for day in ["", ".", "..", "../", "2026-04-12/..", "C:\\", "C:relative", "/tmp",
        "\\\\server\\share", "\\\\?\\C:\\", "2026-02-29", "2024-02-30", "2026-13-01",
        "2026-00-01", "2026-04-00", "2026-4-12", "0000-01-01", "2026-04-12 ", "２０２６-04-12"] {
        assert!(delete_day_internal(&state, day).is_err(), "accepted {day:?}");
        assert_eq!(read_capture_ids_for_day(&state, "2026-04-12").unwrap().len(), 1);
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "outside");
        assert!(state.capture_dir.join("2026-04-12/keep.png").exists());
    }
    assert!(validate_day_key("2024-02-29").is_ok());
    assert!(validate_day_key("2000-02-29").is_ok());
    assert!(validate_day_key("1900-02-29").is_err());
}

#[test]
fn poisoned_stored_paths_are_rejected_before_deleting_rows() {
    let (temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-04-12", "keep", 8, 4).unwrap();
    let id = read_capture_ids_for_day(&state, "2026-04-12").unwrap()[0];
    let outside = temp.path().join("private.txt");
    fs::write(&outside, "outside").unwrap();
    with_connection(&state, |conn| {
        conn.execute("UPDATE captures SET thumbnail_path = ? WHERE id = ?",
            params![outside.to_string_lossy(), id]).unwrap();
        Ok(())
    }).unwrap();
    assert!(delete_capture_internal(&state, id).is_err());
    assert!(delete_day_internal(&state, "2026-04-12").is_err());
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    assert_eq!(read_capture_ids_for_day(&state, "2026-04-12").unwrap(), vec![id]);
    assert!(state.capture_dir.join("2026-04-12/keep.png").exists());
}

#[test]
fn missing_paths_still_require_safe_parents_and_strict_containment() {
    let (_temp, state) = build_test_state();
    assert!(validate_managed_path(&state.capture_dir, &state.capture_dir).is_err());
    assert!(validate_managed_path(&state.capture_dir, &state.capture_dir.join("../missing")).is_err());
    assert!(validate_managed_path(&state.capture_dir, &state.capture_dir.with_file_name("captures-other").join("missing")).is_err());
    assert!(validate_managed_path(&state.capture_dir, &state.capture_dir.join("2026-04-12/missing.jpg")).is_ok());
}

#[test]
fn backup_paths_reject_windows_escapes_and_device_aliases_on_every_platform() {
    for path in ["", ".", "../outside", "C:relative", "C:/absolute", "\\\\server\\share", "\\\\?\\C:\\x",
        "2026-04-12/image.jpg:secret", "2026-04-12/NUL.jpg", "2026-04-12/COM1", "2026-04-12/CONOUT$",
        "2026-04-12/image.jpg.", "2026-04-12/image.jpg ", "/absolute"] {
        assert!(normalize_backup_relative_path(path).is_err(), "accepted {path:?}");
    }
    assert!(normalize_backup_relative_path("2026-04-12/image.jpg").is_ok());
}

#[test]
fn deletion_refuses_directory_indirection_and_preserves_external_tree() {
    let (temp, state) = build_test_state();
    insert_fake_capture(&state, "2026-04-12", "keep", 8, 4).unwrap();
    let outside = temp.path().join("external");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.txt"), "outside").unwrap();
    let link = state.capture_dir.join("2026-04-12/redirect");
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\")).arg(&outside).output().unwrap();
        assert!(status.status.success(), "junction creation failed: {:?}", status);
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(delete_day_internal(&state, "2026-04-12").is_err());
    assert!(validate_managed_path(&state.capture_dir, &link.join("missing.jpg")).is_err());
    assert_eq!(fs::read_to_string(outside.join("private.txt")).unwrap(), "outside");
    assert_eq!(read_capture_ids_for_day(&state, "2026-04-12").unwrap().len(), 1);
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(&link).unwrap();
    // The same policy applies if the day itself or capture root is redirected.
    fs::remove_dir_all(state.capture_dir.join("2026-04-12")).unwrap();
    let day_link = state.capture_dir.join("2026-04-12");
    #[cfg(windows)]
    assert!(std::process::Command::new("cmd").args(["/C", "mklink", "/J"])
        .arg(&day_link).arg(&outside).output().unwrap().status.success());
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&outside, &day_link).unwrap();
    assert!(delete_day_internal(&state, "2026-04-12").is_err());
    #[cfg(windows)]
    fs::remove_dir(&day_link).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(&day_link).unwrap();

    fs::remove_dir(&state.capture_dir).unwrap();
    #[cfg(windows)]
    assert!(std::process::Command::new("cmd").args(["/C", "mklink", "/J"])
        .arg(&state.capture_dir).arg(&outside).output().unwrap().status.success());
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&outside, &state.capture_dir).unwrap();
    assert!(remove_capture_root_tree(&state.capture_dir).is_err());
    assert_eq!(fs::read_to_string(outside.join("private.txt")).unwrap(), "outside");
    #[cfg(windows)]
    fs::remove_dir(&state.capture_dir).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(&state.capture_dir).unwrap();
}
    use std::fs::{File, OpenOptions};
    use tempfile::TempDir;

    const MB: u64 = 1024 * 1024;

    pub(super) fn build_test_state() -> (TempDir, SharedState) {
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
            coordinator: Arc::new(coordinator::CaptureCoordinator::new(settings.clone())),
            commands: Arc::new(coordinator::CommandAdmission::new(8)),
            controls: Arc::new(coordinator::CommandAdmission::new(2)),
            backups: Arc::new(coordinator::CommandAdmission::new(1)),
            storage_gate: Arc::new(Mutex::new(())),
            _archive_lock: storage::lock_archive(temp_dir.path()).unwrap(),
        };

        (temp_dir, state)
    }

    fn create_file_with_size(path: &Path, size: u64) -> Result<(), String> {
        let file = File::create(path)
            .map_err(|error| format!("failed to create test file {}: {error}", path.display()))?;
        file.set_len(size)
            .map_err(|error| format!("failed to resize test file {}: {error}", path.display()))
    }

    pub(super) fn insert_fake_capture(
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

            storage::record_live(conn, &image_path)?;
            storage::record_live(conn, &thumb_path)?;
            Ok(())
        })
    }

    pub(super) fn set_settings_for_test(
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

        storage::reconcile(&state).expect("failed to reconcile externally resized fixture files");
        set_settings_for_test(&state, 365, 0.5).expect("failed to set storage-cap retention settings");
        apply_retention_rules(&state).expect("storage-cap retention purge failed");

        let after_cap_purge = read_day_keys(&state).expect("failed to read day keys after cap purge");
        assert_eq!(after_cap_purge, vec![new_day.clone()]);
        assert!(!state.capture_dir.join(mid_day).exists());
        assert!(state.capture_dir.join(new_day).exists());
    }
