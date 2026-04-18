use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{Local, NaiveDate, Timelike};
use image::codecs::jpeg::JpegEncoder;
use rusqlite::{params, Connection};
use screenshots::Screen;
use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};

const DB_FILENAME: &str = "memorylane.db";
const DEFAULT_INTERVAL_MINUTES: i64 = 2;
const MIN_INTERVAL_MINUTES: i64 = 1;
const MAX_INTERVAL_MINUTES: i64 = 240;
const DEFAULT_RETENTION_DAYS: i64 = 30;
const DEFAULT_STORAGE_CAP_GB: f64 = 5.0;

fn startup_on_boot_supported() -> bool {
    cfg!(all(feature = "startup-on-boot", target_os = "windows"))
}

#[derive(Clone)]
struct SharedState {
    db: Arc<Mutex<Connection>>,
    capture_dir: PathBuf,
    pause_state: Arc<AtomicBool>,
    consecutive_capture_failures: Arc<AtomicU32>,
    last_capture_error: Arc<Mutex<Option<String>>>,
    allow_exit: Arc<AtomicBool>,
}

#[derive(Clone)]
struct Settings {
    interval_minutes: i64,
    retention_days: i64,
    storage_cap_gb: f64,
    is_paused: bool,
    startup_on_boot: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPayload {
    interval_minutes: i64,
    retention_days: i64,
    storage_cap_gb: f64,
    is_paused: bool,
    startup_on_boot: bool,
    startup_on_boot_supported: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PauseStatePayload {
    is_paused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaySummaryPayload {
    day_key: String,
    capture_count: i64,
    density: Vec<f64>,
    first_capture_at: Option<String>,
    last_capture_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DayCapturePayload {
    id: i64,
    day_key: String,
    captured_at: String,
    timestamp_label: String,
    image_path: String,
    thumbnail_data_url: String,
    capture_note: String,
    width: i64,
    height: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureImagePayload {
    id: i64,
    image_data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureHealthPayload {
    consecutive_failures: u32,
    last_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureErrorEventPayload {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageStatsPayload {
    used_bytes: u64,
    used_gb: f64,
    storage_cap_gb: f64,
    usage_percent: f64,
    capture_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteDayPayload {
    day_key: String,
    removed_rows: i64,
    removed_files: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCapturePayload {
    capture_id: i64,
    day_key: String,
    removed_files: i64,
}

fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data path: {error}"))?;

    fs::create_dir_all(&app_data)
        .map_err(|error| format!("failed to ensure app data directory exists: {error}"))?;

    Ok(app_data)
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "failed to create destination directory {}: {error}",
            destination.display()
        )
    })?;

    let entries = fs::read_dir(source)
        .map_err(|error| format!("failed to read source directory {}: {error}", source.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read source entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if source_path.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else if source_path.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "failed to copy file {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn capture_count_in_db(db_path: &Path) -> i64 {
    if !db_path.exists() {
        return 0;
    }

    let Ok(conn) = Connection::open(db_path) else {
        return 0;
    };

    conn.query_row("SELECT COUNT(*) FROM captures", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

fn migrate_legacy_app_data_if_needed(current_app_data: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = current_app_data;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let Some(appdata_root) = std::env::var_os("APPDATA") else {
            return Ok(());
        };

        let legacy_app_data = PathBuf::from(appdata_root).join("com.memorylane.app");

        if !legacy_app_data.exists() || legacy_app_data == current_app_data {
            return Ok(());
        }

        let legacy_db = legacy_app_data.join(DB_FILENAME);
        if !legacy_db.exists() {
            return Ok(());
        }

        let current_db = current_app_data.join(DB_FILENAME);
        let legacy_count = capture_count_in_db(&legacy_db);
        let current_count = capture_count_in_db(&current_db);

        if legacy_count <= current_count {
            return Ok(());
        }

        fs::create_dir_all(current_app_data).map_err(|error| {
            format!(
                "failed to ensure current app data directory {}: {error}",
                current_app_data.display()
            )
        })?;

        fs::copy(&legacy_db, &current_db).map_err(|error| {
            format!(
                "failed to copy legacy database {} to {}: {error}",
                legacy_db.display(),
                current_db.display()
            )
        })?;

        let legacy_captures = legacy_app_data.join("captures");
        let current_captures = current_app_data.join("captures");

        if legacy_captures.exists() {
            if current_captures.exists() {
                fs::remove_dir_all(&current_captures).map_err(|error| {
                    format!(
                        "failed to clear current captures directory {}: {error}",
                        current_captures.display()
                    )
                })?;
            }

            copy_directory_recursive(&legacy_captures, &current_captures)?;
        }

        Ok(())
    }
}

fn initialize_database(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            interval_minutes INTEGER NOT NULL,
            retention_days INTEGER NOT NULL,
            storage_cap_gb REAL NOT NULL,
            is_paused INTEGER NOT NULL,
            startup_on_boot INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS captures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_key TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            image_path TEXT NOT NULL,
            thumbnail_path TEXT NOT NULL,
            capture_note TEXT NOT NULL DEFAULT '',
            width INTEGER NOT NULL,
            height INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_captures_day_time ON captures(day_key, captured_at);
        ",
    )
    .map_err(|error| format!("failed to initialize database schema: {error}"))?;

    // Support existing databases created before the startup_on_boot column existed.
    let _ = conn.execute(
        "ALTER TABLE settings ADD COLUMN startup_on_boot INTEGER NOT NULL DEFAULT 0",
        [],
    );

    // Support existing databases created before capture_note was introduced.
    let _ = conn.execute(
        "ALTER TABLE captures ADD COLUMN capture_note TEXT NOT NULL DEFAULT ''",
        [],
    );

    conn.execute(
        "
        INSERT INTO settings (id, interval_minutes, retention_days, storage_cap_gb, is_paused, startup_on_boot)
        VALUES (1, ?, ?, ?, 0, 0)
        ON CONFLICT(id) DO NOTHING
        ",
        params![
            DEFAULT_INTERVAL_MINUTES,
            DEFAULT_RETENTION_DAYS,
            DEFAULT_STORAGE_CAP_GB
        ],
    )
    .map_err(|error| format!("failed to seed default settings: {error}"))?;

    Ok(())
}

fn read_settings(conn: &Connection) -> Result<Settings, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT interval_minutes, retention_days, storage_cap_gb, is_paused, startup_on_boot
            FROM settings
            WHERE id = 1
            ",
        )
        .map_err(|error| format!("failed to prepare settings query: {error}"))?;

    let settings = stmt
        .query_row([], |row| {
            Ok(Settings {
                interval_minutes: row.get(0)?,
                retention_days: row.get(1)?,
                storage_cap_gb: row.get(2)?,
                is_paused: row.get::<_, i64>(3)? != 0,
                startup_on_boot: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|error| format!("failed to read settings: {error}"))?;

    Ok(settings)
}

fn write_settings(conn: &Connection, settings: &Settings) -> Result<(), String> {
    conn.execute(
        "
        UPDATE settings
        SET interval_minutes = ?, retention_days = ?, storage_cap_gb = ?, is_paused = ?, startup_on_boot = ?
        WHERE id = 1
        ",
        params![
            settings.interval_minutes,
            settings.retention_days,
            settings.storage_cap_gb,
            if settings.is_paused { 1 } else { 0 },
            if settings.startup_on_boot { 1 } else { 0 }
        ],
    )
    .map_err(|error| format!("failed to write settings: {error}"))?;

    Ok(())
}

fn with_connection<T>(state: &SharedState, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "failed to lock database connection".to_string())?;
    f(&conn)
}

fn settings_to_payload(settings: Settings) -> SettingsPayload {
    SettingsPayload {
        interval_minutes: settings.interval_minutes,
        retention_days: settings.retention_days,
        storage_cap_gb: settings.storage_cap_gb,
        is_paused: settings.is_paused,
        startup_on_boot: settings.startup_on_boot,
        startup_on_boot_supported: startup_on_boot_supported(),
    }
}

#[cfg(all(feature = "startup-on-boot", target_os = "windows"))]
fn apply_startup_on_boot_setting(_app: &AppHandle, enabled: bool) -> Result<(), String> {
    let executable_path = std::env::current_exe()
        .map_err(|error| format!("failed to resolve current executable path: {error}"))?;
    let run_key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

    if enabled {
        let command_value = format!("\"{}\"", executable_path.display());
        let status = Command::new("reg")
            .arg("add")
            .arg(run_key)
            .arg("/v")
            .arg("MemoryLane")
            .arg("/t")
            .arg("REG_SZ")
            .arg("/d")
            .arg(&command_value)
            .arg("/f")
            .status()
            .map_err(|error| format!("failed to register startup entry: {error}"))?;

        if !status.success() {
            return Err("failed to enable startup-on-boot registry entry".to_string());
        }
    } else {
        let _ = Command::new("reg")
            .arg("delete")
            .arg(run_key)
            .arg("/v")
            .arg("MemoryLane")
            .arg("/f")
            .status();
    }

    Ok(())
}

#[cfg(not(all(feature = "startup-on-boot", target_os = "windows")))]
fn apply_startup_on_boot_setting(_app: &AppHandle, _enabled: bool) -> Result<(), String> {
    Err("startup-on-boot is disabled for this build".to_string())
}

fn clear_capture_error_state(state: &SharedState) {
    state
        .consecutive_capture_failures
        .store(0, Ordering::Relaxed);

    if let Ok(mut error_slot) = state.last_capture_error.lock() {
        *error_slot = None;
    }
}

fn record_capture_error(state: &SharedState, message: String) -> CaptureErrorEventPayload {
    state
        .consecutive_capture_failures
        .fetch_add(1, Ordering::Relaxed);

    if let Ok(mut error_slot) = state.last_capture_error.lock() {
        *error_slot = Some(message.clone());
    }

    CaptureErrorEventPayload { message }
}

fn capture_health_payload(state: &SharedState) -> CaptureHealthPayload {
    let last_error = state
        .last_capture_error
        .lock()
        .ok()
        .and_then(|slot| slot.clone());

    CaptureHealthPayload {
        consecutive_failures: state.consecutive_capture_failures.load(Ordering::Relaxed),
        last_error,
    }
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    let entries = fs::read_dir(path)
        .map_err(|error| format!("failed to list directory {}: {error}", path.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to access directory entry: {error}"))?;
        let entry_path = entry.path();

        if entry_path.is_dir() {
            total = total.saturating_add(directory_size(&entry_path)?);
        } else if entry_path.is_file() {
            let metadata = fs::metadata(&entry_path)
                .map_err(|error| format!("failed to read metadata for {}: {error}", entry_path.display()))?;
            total = total.saturating_add(metadata.len());
        }
    }

    Ok(total)
}

fn load_image_data_url(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("failed to read image {}: {error}", path))?;
    let mime = if path.to_ascii_lowercase().ends_with(".jpg")
        || path.to_ascii_lowercase().ends_with(".jpeg")
    {
        "image/jpeg"
    } else {
        "image/png"
    };

    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn density_for_day(conn: &Connection, day_key: &str) -> Result<Vec<f64>, String> {
    let mut bins = vec![0_f64; 8];

    let mut stmt = conn
        .prepare("SELECT captured_at FROM captures WHERE day_key = ? ORDER BY captured_at ASC")
        .map_err(|error| format!("failed to prepare density query: {error}"))?;

    let mut rows = stmt
        .query(params![day_key])
        .map_err(|error| format!("failed to run density query: {error}"))?;

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("failed to read density row: {error}"))?
    {
        let captured_at: String = row
            .get(0)
            .map_err(|error| format!("failed to read density timestamp: {error}"))?;
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&captured_at) {
            let local_hour = parsed.with_timezone(&Local).hour() as usize;
            let index = (local_hour / 3).min(7);
            bins[index] += 1.0;
        }
    }

    let max_bin = bins
        .iter()
        .copied()
        .fold(0.0_f64, |acc, value| if value > acc { value } else { acc });

    if max_bin > 0.0 {
        for bin in &mut bins {
            *bin /= max_bin;
        }
    }

    Ok(bins)
}

fn delete_day_internal(state: &SharedState, day_key: &str) -> Result<DeleteDayPayload, String> {
    let mut image_paths = Vec::<String>::new();
    let mut thumbnail_paths = Vec::<String>::new();

    let removed_rows = with_connection(state, |conn| {
        let mut path_stmt = conn
            .prepare("SELECT image_path, thumbnail_path FROM captures WHERE day_key = ?")
            .map_err(|error| format!("failed to prepare day file query: {error}"))?;
        let mut rows = path_stmt
            .query(params![day_key])
            .map_err(|error| format!("failed to query day files: {error}"))?;

        while let Some(row) = rows
            .next()
            .map_err(|error| format!("failed to read day file row: {error}"))?
        {
            image_paths.push(
                row.get(0)
                    .map_err(|error| format!("failed to read image path: {error}"))?,
            );
            thumbnail_paths.push(
                row.get(1)
                    .map_err(|error| format!("failed to read thumbnail path: {error}"))?,
            );
        }

        let removed = conn
            .execute("DELETE FROM captures WHERE day_key = ?", params![day_key])
            .map_err(|error| format!("failed to delete day captures: {error}"))?;

        Ok(removed as i64)
    })?;

    let mut removed_files = 0_i64;

    for path in image_paths.iter().chain(thumbnail_paths.iter()) {
        if fs::metadata(path).is_ok() {
            fs::remove_file(path).map_err(|error| format!("failed to remove file {}: {error}", path))?;
            removed_files += 1;
        }
    }

    let day_dir = state.capture_dir.join(day_key);
    if day_dir.exists() {
        let _ = fs::remove_dir_all(&day_dir);
    }

    Ok(DeleteDayPayload {
        day_key: day_key.to_string(),
        removed_rows,
        removed_files,
    })
}

fn delete_capture_internal(state: &SharedState, capture_id: i64) -> Result<DeleteCapturePayload, String> {
    let (day_key, image_path, thumbnail_path) = with_connection(state, |conn| {
        conn.query_row(
            "SELECT day_key, image_path, thumbnail_path FROM captures WHERE id = ?",
            params![capture_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| format!("failed to resolve capture for deletion: {error}"))
    })?;

    with_connection(state, |conn| {
        conn.execute("DELETE FROM captures WHERE id = ?", params![capture_id])
            .map_err(|error| format!("failed to delete capture row: {error}"))?;

        Ok(())
    })?;

    let mut removed_files = 0_i64;

    for path in [&image_path, &thumbnail_path] {
        if fs::metadata(path).is_ok() {
            fs::remove_file(path).map_err(|error| format!("failed to remove file {}: {error}", path))?;
            removed_files += 1;
        }
    }

    let day_dir = state.capture_dir.join(&day_key);
    if day_dir.exists() {
        let day_capture_count = with_connection(state, |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM captures WHERE day_key = ?",
                params![day_key],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("failed to count remaining day captures: {error}"))
        })?;

        if day_capture_count == 0 {
            let _ = fs::remove_dir_all(&day_dir);
        }
    }

    Ok(DeleteCapturePayload {
        capture_id,
        day_key,
        removed_files,
    })
}

fn apply_retention_rules(state: &SharedState) -> Result<(), String> {
    let settings = with_connection(state, read_settings)?;
    let keep_days = settings.retention_days.max(1);

    let mut day_keys = with_connection(state, |conn| {
        let mut stmt = conn
            .prepare("SELECT DISTINCT day_key FROM captures ORDER BY day_key ASC")
            .map_err(|error| format!("failed to prepare day list query: {error}"))?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to run day list query: {error}"))?;

        let mut collected = Vec::new();
        for row in rows {
            collected.push(row.map_err(|error| format!("failed to read day key: {error}"))?);
        }

        Ok(collected)
    })?;

    let today = Local::now().date_naive();
    let cutoff = today
        .checked_sub_days(chrono::Days::new((keep_days.saturating_sub(1)) as u64))
        .unwrap_or(today);

    for day_key in day_keys.clone() {
        if let Ok(day_date) = NaiveDate::parse_from_str(&day_key, "%Y-%m-%d") {
            if day_date < cutoff {
                let _ = delete_day_internal(state, &day_key)?;
            }
        }
    }

    day_keys = with_connection(state, |conn| {
        let mut stmt = conn
            .prepare("SELECT DISTINCT day_key FROM captures ORDER BY day_key ASC")
            .map_err(|error| format!("failed to prepare post-age day list query: {error}"))?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to run post-age day list query: {error}"))?;

        let mut collected = Vec::new();
        for row in rows {
            collected.push(row.map_err(|error| format!("failed to read post-age day key: {error}"))?);
        }

        Ok(collected)
    })?;

    let cap_bytes = ((settings.storage_cap_gb.max(0.5)) * 1024.0 * 1024.0 * 1024.0) as u64;

    while directory_size(&state.capture_dir)? > cap_bytes {
        let oldest_day = day_keys.first().cloned();

        match oldest_day {
            Some(day_key) => {
                let _ = delete_day_internal(state, &day_key)?;
                day_keys.remove(0);
            }
            None => break,
        }
    }

    Ok(())
}

fn capture_once(state: &SharedState) -> Result<(), String> {
    let screen = Screen::all()
        .map_err(|error| format!("failed to list displays: {error}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "no display available for capture".to_string())?;

    let screenshot = screen
        .capture()
        .map_err(|error| format!("failed to capture primary display: {error}"))?;

    let now = Local::now();
    let day_key = now.format("%Y-%m-%d").to_string();
    let day_dir = state.capture_dir.join(&day_key);

    fs::create_dir_all(&day_dir)
        .map_err(|error| format!("failed to ensure day capture directory exists: {error}"))?;

    let stem = now.format("%Y%m%d_%H%M%S_%3f").to_string();
    let image_path = day_dir.join(format!("{stem}.jpg"));
    let thumbnail_path = day_dir.join(format!("{stem}_thumb.jpg"));
    let full_image = image::DynamicImage::ImageRgba8(screenshot.clone());

    {
        let file = File::create(&image_path)
            .map_err(|error| format!("failed to create screenshot file: {error}"))?;
        let writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(writer, 82);
        encoder
            .encode_image(&full_image)
            .map_err(|error| format!("failed to encode screenshot jpeg: {error}"))?;
    }

    {
        let thumbnail = full_image.thumbnail(360, 202);
        let file = File::create(&thumbnail_path)
            .map_err(|error| format!("failed to create thumbnail file: {error}"))?;
        let writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(writer, 68);
        encoder
            .encode_image(&thumbnail)
            .map_err(|error| format!("failed to encode thumbnail jpeg: {error}"))?;
    }

    with_connection(state, |conn| {
        conn.execute(
            "
            INSERT INTO captures (day_key, captured_at, image_path, thumbnail_path, capture_note, width, height)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                day_key,
                now.to_rfc3339(),
                image_path.to_string_lossy().to_string(),
                thumbnail_path.to_string_lossy().to_string(),
                "",
                screenshot.width() as i64,
                screenshot.height() as i64
            ],
        )
        .map_err(|error| format!("failed to persist capture metadata: {error}"))?;

        Ok(())
    })?;

    apply_retention_rules(state)?;
    clear_capture_error_state(state);
    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_pause_internal(state: &SharedState, is_paused: bool) -> Result<(), String> {
    with_connection(state, |conn| {
        let mut settings = read_settings(conn)?;
        settings.is_paused = is_paused;
        write_settings(conn, &settings)
    })?;

    state.pause_state.store(is_paused, Ordering::Relaxed);
    Ok(())
}

fn start_capture_worker(app: AppHandle, state: SharedState) {
    std::thread::spawn(move || {
        loop {
            let settings = with_connection(&state, read_settings);

            if let Ok(current_settings) = settings {
                state
                    .pause_state
                    .store(current_settings.is_paused, Ordering::Relaxed);

                if !current_settings.is_paused {
                    match capture_once(&state) {
                        Ok(()) => {
                            let _ = app.emit("captures-updated", ());
                        }
                        Err(error) => {
                            let payload = record_capture_error(&state, error);
                            let _ = app.emit("capture-error", payload);
                        }
                    }
                }

                let sleep_seconds = (current_settings.interval_minutes.max(1) * 60) as u64;
                std::thread::sleep(Duration::from_secs(sleep_seconds));
            } else {
                std::thread::sleep(Duration::from_secs(20));
            }
        }
    });
}

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let open_dashboard = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard")
        .build(app)
        .map_err(|error| format!("failed to build open dashboard menu item: {error}"))?;
    let toggle_pause = MenuItemBuilder::with_id("toggle_pause", "Pause/Resume Recording")
        .build(app)
        .map_err(|error| format!("failed to build pause menu item: {error}"))?;
    let open_folder = MenuItemBuilder::with_id("open_folder", "Open Captures Folder")
        .build(app)
        .map_err(|error| format!("failed to build open folder menu item: {error}"))?;
    let capture_now = MenuItemBuilder::with_id("capture_now", "Capture Now")
        .build(app)
        .map_err(|error| format!("failed to build capture now menu item: {error}"))?;
    let quit = MenuItemBuilder::with_id("quit_app", "Quit")
        .build(app)
        .map_err(|error| format!("failed to build quit menu item: {error}"))?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &open_dashboard,
            &toggle_pause,
            &open_folder,
            &capture_now,
            &quit,
        ])
        .build()
        .map_err(|error| format!("failed to build tray menu: {error}"))?;

    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("MemoryLane")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_dashboard" => {
                show_main_window(app);
            }
            "toggle_pause" => {
                let state = app.state::<SharedState>();
                let next_state = !state.pause_state.load(Ordering::Relaxed);
                if set_pause_internal(&state, next_state).is_ok() {
                    let _ = app.emit("pause-state-changed", PauseStatePayload { is_paused: next_state });
                }
            }
            "open_folder" => {
                let state = app.state::<SharedState>();
                let _ = Command::new("explorer").arg(&state.capture_dir).spawn();
            }
            "capture_now" => {
                let state = app.state::<SharedState>();
                match capture_once(&state) {
                    Ok(()) => {
                        let _ = app.emit("captures-updated", ());
                    }
                    Err(error) => {
                        let payload = record_capture_error(&state, error);
                        let _ = app.emit("capture-error", payload);
                    }
                }
            }
            "quit_app" => {
                let state = app.state::<SharedState>();
                state.allow_exit.store(true, Ordering::Relaxed);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| format!("failed to build tray icon: {error}"))?;

    Ok(())
}

#[tauri::command]
fn get_storage_path(state: State<SharedState>) -> String {
    state.capture_dir.to_string_lossy().to_string()
}

#[tauri::command]
fn open_captures_folder(state: State<SharedState>) -> Result<(), String> {
    Command::new("explorer")
        .arg(&state.capture_dir)
        .spawn()
        .map_err(|error| format!("failed to open captures folder: {error}"))?;
    Ok(())
}

#[tauri::command]
fn get_settings(state: State<SharedState>) -> Result<SettingsPayload, String> {
    with_connection(&state, |conn| read_settings(conn).map(settings_to_payload))
}

#[tauri::command]
fn update_settings(
    state: State<SharedState>,
    interval_minutes: Option<i64>,
    retention_days: Option<i64>,
    storage_cap_gb: Option<f64>,
) -> Result<SettingsPayload, String> {
    let updated = with_connection(&state, |conn| {
        let mut settings = read_settings(conn)?;

        if let Some(interval) = interval_minutes {
            settings.interval_minutes = interval.clamp(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);
        }

        if let Some(retention) = retention_days {
            settings.retention_days = retention.clamp(1, 365);
        }

        if let Some(cap) = storage_cap_gb {
            settings.storage_cap_gb = cap.clamp(0.5, 100.0);
        }

        write_settings(conn, &settings)?;
        Ok(settings)
    })?;

    apply_retention_rules(&state)?;
    Ok(settings_to_payload(updated))
}

#[tauri::command]
fn set_startup_on_boot(
    state: State<SharedState>,
    app: AppHandle,
    enabled: bool,
) -> Result<SettingsPayload, String> {
    if !startup_on_boot_supported() {
        return Err("startup-on-boot is disabled in this build".to_string());
    }

    apply_startup_on_boot_setting(&app, enabled)?;

    let updated = with_connection(&state, |conn| {
        let mut settings = read_settings(conn)?;
        settings.startup_on_boot = enabled;
        write_settings(conn, &settings)?;
        Ok(settings)
    })?;

    Ok(settings_to_payload(updated))
}

#[tauri::command]
fn set_pause_state(state: State<SharedState>, app: AppHandle, is_paused: bool) -> Result<PauseStatePayload, String> {
    set_pause_internal(&state, is_paused)?;
    app.emit("pause-state-changed", PauseStatePayload { is_paused })
        .map_err(|error| format!("failed to emit pause state event: {error}"))?;
    Ok(PauseStatePayload { is_paused })
}

#[tauri::command]
fn get_pause_state(state: State<SharedState>) -> PauseStatePayload {
    PauseStatePayload {
        is_paused: state.pause_state.load(Ordering::Relaxed),
    }
}

#[tauri::command]
fn capture_now(state: State<SharedState>, app: AppHandle) -> Result<(), String> {
    match capture_once(&state) {
        Ok(()) => {
            app.emit("captures-updated", ())
                .map_err(|error| format!("failed to emit capture update event: {error}"))?;
            Ok(())
        }
        Err(error) => {
            let payload = record_capture_error(&state, error.clone());
            app.emit("capture-error", payload)
                .map_err(|emit_error| format!("failed to emit capture error event: {emit_error}"))?;
            Err(error)
        }
    }
}

#[tauri::command]
fn get_day_summaries(state: State<SharedState>) -> Result<Vec<DaySummaryPayload>, String> {
    with_connection(&state, |conn| {
        let mut stmt = conn
            .prepare(
                "
                SELECT day_key, COUNT(*) as capture_count, MIN(captured_at), MAX(captured_at)
                FROM captures
                GROUP BY day_key
                ORDER BY day_key DESC
                ",
            )
            .map_err(|error| format!("failed to prepare day summaries query: {error}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| format!("failed to run day summaries query: {error}"))?;

        let mut summaries = Vec::new();

        for row in rows {
            let (day_key, count, first_capture_at, last_capture_at) =
                row.map_err(|error| format!("failed to read day summary row: {error}"))?;

            summaries.push(DaySummaryPayload {
                density: density_for_day(conn, &day_key)?,
                day_key,
                capture_count: count,
                first_capture_at,
                last_capture_at,
            });
        }

        Ok(summaries)
    })
}

#[tauri::command]
fn get_day_captures(
    state: State<SharedState>,
    day_key: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<DayCapturePayload>, String> {
    let safe_offset = offset.unwrap_or(0).max(0);
    let safe_limit = limit.unwrap_or(240).clamp(1, 1000);

    let rows = with_connection(&state, |conn| {
        let mut stmt = conn
            .prepare(
                "
                SELECT id, day_key, captured_at, image_path, thumbnail_path, capture_note, width, height
                FROM captures
                WHERE day_key = ?
                ORDER BY captured_at ASC
                LIMIT ? OFFSET ?
                ",
            )
            .map_err(|error| format!("failed to prepare day captures query: {error}"))?;

        let rows = stmt
            .query_map(params![day_key, safe_limit, safe_offset], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(|error| format!("failed to run day captures query: {error}"))?;

        let mut capture_rows = Vec::new();

        for row in rows {
            let (id, row_day_key, captured_at, image_path, thumbnail_path, capture_note, width, height) =
                row.map_err(|error| format!("failed to read capture row: {error}"))?;

            capture_rows.push((
                id,
                row_day_key,
                captured_at,
                image_path,
                thumbnail_path,
                capture_note,
                width,
                height,
            ));
        }

        Ok(capture_rows)
    })?;

    let mut captures = Vec::new();

    for (id, row_day_key, captured_at, image_path, thumbnail_path, capture_note, width, height) in rows {
        let timestamp_label = chrono::DateTime::parse_from_rfc3339(&captured_at)
            .map(|dt| dt.with_timezone(&Local).format("%I:%M %p").to_string())
            .unwrap_or_else(|_| captured_at.clone());

        captures.push(DayCapturePayload {
            id,
            day_key: row_day_key,
            captured_at,
            timestamp_label,
            image_path,
            thumbnail_data_url: load_image_data_url(&thumbnail_path)?,
            capture_note,
            width,
            height,
        });
    }

    Ok(captures)
}

#[tauri::command]
fn get_capture_image(state: State<SharedState>, capture_id: i64) -> Result<CaptureImagePayload, String> {
    let image_path = with_connection(&state, |conn| {
        conn.query_row(
            "SELECT image_path FROM captures WHERE id = ?",
            params![capture_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("failed to load capture image path: {error}"))
    })?;

    Ok(CaptureImagePayload {
        id: capture_id,
        image_data_url: load_image_data_url(&image_path)?,
    })
}

#[tauri::command]
fn update_capture_note(
    state: State<SharedState>,
    app: AppHandle,
    capture_id: i64,
    note: String,
) -> Result<(), String> {
    with_connection(&state, |conn| {
        let updated_rows = conn
            .execute(
                "UPDATE captures SET capture_note = ? WHERE id = ?",
                params![note, capture_id],
            )
            .map_err(|error| format!("failed to update capture note: {error}"))?;

        if updated_rows == 0 {
            return Err("capture not found for note update".to_string());
        }

        Ok(())
    })?;

    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event: {error}"))?;

    Ok(())
}

#[tauri::command]
fn get_capture_health(state: State<SharedState>) -> CaptureHealthPayload {
    capture_health_payload(&state)
}

#[tauri::command]
fn get_storage_stats(state: State<SharedState>) -> Result<StorageStatsPayload, String> {
    let used_bytes = directory_size(&state.capture_dir)?;
    let used_gb = used_bytes as f64 / (1024.0 * 1024.0 * 1024.0);

    let (capture_count, cap_gb) = with_connection(&state, |conn| {
        let count = conn
            .query_row("SELECT COUNT(*) FROM captures", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("failed to count captures: {error}"))?;
        let settings = read_settings(conn)?;
        Ok((count, settings.storage_cap_gb))
    })?;

    let usage_percent = if cap_gb > 0.0 {
        (used_gb / cap_gb * 100.0).min(100.0)
    } else {
        0.0
    };

    Ok(StorageStatsPayload {
        used_bytes,
        used_gb,
        storage_cap_gb: cap_gb,
        usage_percent,
        capture_count,
    })
}

#[tauri::command]
fn delete_day(state: State<SharedState>, day_key: String, app: AppHandle) -> Result<DeleteDayPayload, String> {
    let payload = delete_day_internal(&state, &day_key)?;
    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event: {error}"))?;
    Ok(payload)
}

#[tauri::command]
fn delete_capture(state: State<SharedState>, capture_id: i64, app: AppHandle) -> Result<DeleteCapturePayload, String> {
    let payload = delete_capture_internal(&state, capture_id)?;
    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event: {error}"))?;
    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let app_data_dir = resolve_app_data_dir(&app_handle)?;
            migrate_legacy_app_data_if_needed(&app_data_dir)?;

            let capture_dir = app_data_dir.join("captures");
            fs::create_dir_all(&capture_dir).map_err(|error| {
                format!(
                    "failed to ensure captures directory exists: {} ({error})",
                    capture_dir.display()
                )
            })?;

            let db_path = app_data_dir.join(DB_FILENAME);

            let conn = Connection::open(&db_path)
                .map_err(|error| format!("failed to open database {}: {error}", db_path.display()))?;
            initialize_database(&conn)?;

            let current_settings = read_settings(&conn)?;

            let state = SharedState {
                db: Arc::new(Mutex::new(conn)),
                capture_dir,
                pause_state: Arc::new(AtomicBool::new(current_settings.is_paused)),
                consecutive_capture_failures: Arc::new(AtomicU32::new(0)),
                last_capture_error: Arc::new(Mutex::new(None)),
                allow_exit: Arc::new(AtomicBool::new(false)),
            };

            app.manage(state.clone());
            setup_tray(&app_handle)?;

            if current_settings.startup_on_boot && startup_on_boot_supported() {
                let _ = apply_startup_on_boot_setting(&app_handle, true);
            }

            if let Some(window) = app_handle.get_webview_window("main") {
                let allow_exit = state.allow_exit.clone();
                let window_handle = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if !allow_exit.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = window_handle.hide();
                        }
                    }
                });
            }

            start_capture_worker(app_handle.clone(), state.clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_storage_path,
            open_captures_folder,
            get_settings,
            update_settings,
            set_startup_on_boot,
            get_pause_state,
            set_pause_state,
            capture_now,
            get_day_summaries,
            get_day_captures,
            get_capture_image,
            update_capture_note,
            get_capture_health,
            get_storage_stats,
            delete_day,
            delete_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, OpenOptions};
    use tempfile::TempDir;

    const MB: u64 = 1024 * 1024;

    fn build_test_state() -> (TempDir, SharedState) {
        let temp_dir = TempDir::new().expect("failed to create temp directory");
        let capture_dir = temp_dir.path().join("captures");
        fs::create_dir_all(&capture_dir).expect("failed to create capture directory");

        let db_path = temp_dir.path().join("memorylane-test.db");
        let conn = Connection::open(&db_path).expect("failed to open test sqlite db");
        initialize_database(&conn).expect("failed to initialize test db schema");

        let settings = read_settings(&conn).expect("failed to read default settings");

        let state = SharedState {
            db: Arc::new(Mutex::new(conn)),
            capture_dir,
            pause_state: Arc::new(AtomicBool::new(settings.is_paused)),
            consecutive_capture_failures: Arc::new(AtomicU32::new(0)),
            last_capture_error: Arc::new(Mutex::new(None)),
            allow_exit: Arc::new(AtomicBool::new(false)),
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
}
