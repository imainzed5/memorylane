use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{Local, NaiveDate, Timelike};
use image::codecs::jpeg::JpegEncoder;
use pbkdf2::pbkdf2_hmac;
use rand::rngs::OsRng;
use rand::RngCore;
use rusqlite::{params, Connection};
use screenshots::Screen;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::CloseHandle;
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
};

const DB_FILENAME: &str = "memorylane.db";
const DEFAULT_INTERVAL_MINUTES: i64 = 2;
const MIN_INTERVAL_MINUTES: i64 = 1;
const MAX_INTERVAL_MINUTES: i64 = 240;
const DEFAULT_RETENTION_DAYS: i64 = 30;
const DEFAULT_STORAGE_CAP_GB: f64 = 5.0;
const LEGACY_THEME_ID: &str = "amber-noir";

const VALID_THEME_IDS: [&str; 5] = [
    LEGACY_THEME_ID,
    "obsidian-jade",
    "arctic-slate",
    "deep-plum",
    "midnight-blue",
];

const SEARCH_CACHE_CAPACITY: usize = 64;
const INTELLIGENCE_CACHE_CAPACITY: usize = 32;
const INTELLIGENCE_SESSION_GAP_MINUTES: i64 = 20;

const BACKUP_MAGIC: &[u8; 5] = b"MLBK1";
const BACKUP_SALT_LEN: usize = 16;
const BACKUP_NONCE_LEN: usize = 12;
const BACKUP_KDF_ROUNDS: u32 = 120_000;
const BACKUP_VERSION: i64 = 1;

fn startup_on_boot_supported() -> bool {
    cfg!(all(feature = "startup-on-boot", target_os = "windows"))
}

#[derive(Clone)]
struct SharedState {
    db: Arc<Mutex<Connection>>,
    capture_dir: PathBuf,
    backup_dir: PathBuf,
    pause_state: Arc<AtomicBool>,
    consecutive_capture_failures: Arc<AtomicU32>,
    last_capture_error: Arc<Mutex<Option<String>>>,
    allow_exit: Arc<AtomicBool>,
    indexing_epoch: Arc<AtomicU64>,
    search_cache: Arc<Mutex<HashMap<String, SearchCacheEntry>>>,
    intelligence_cache: Arc<Mutex<HashMap<String, IntelligenceCacheEntry>>>,
    performance_stats: Arc<Mutex<PerformanceStats>>,
}

#[derive(Clone)]
struct Settings {
    interval_minutes: i64,
    retention_days: i64,
    storage_cap_gb: f64,
    is_paused: bool,
    startup_on_boot: bool,
    theme_id: String,
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
    theme_id: String,
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
    ocr_text: String,
    window_title: String,
    process_name: String,
    width: i64,
    height: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalSearchResultPayload {
    capture_id: i64,
    day_key: String,
    captured_at: String,
    timestamp_label: String,
    snippet: String,
    match_reason: String,
    match_sources: Vec<String>,
    score: f64,
    snippet_source: String,
    highlight_terms: Vec<String>,
}

#[derive(Clone, Default)]
struct WindowContextMetadata {
    window_title: String,
    process_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DayFocusBlockPayload {
    start_timestamp_label: String,
    end_timestamp_label: String,
    capture_count: i64,
    dominant_context: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DayIntelligencePayload {
    day_key: String,
    summary: String,
    focus_blocks: Vec<DayFocusBlockPayload>,
    change_highlights: Vec<String>,
    top_terms: Vec<String>,
    generated_at: String,
    generation_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportBackupPayload {
    capture_count: i64,
    day_count: i64,
    restored_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceSnapshotPayload {
    last_search_ms: i64,
    last_intelligence_ms: i64,
    search_cache_hits: u64,
    intelligence_cache_hits: u64,
}

#[derive(Clone, Default)]
struct PerformanceStats {
    last_search_ms: i64,
    last_intelligence_ms: i64,
    search_cache_hits: u64,
    intelligence_cache_hits: u64,
}

#[derive(Clone)]
struct SearchCacheEntry {
    epoch: u64,
    results: Vec<RetrievalSearchResultPayload>,
}

#[derive(Clone)]
struct IntelligenceCacheEntry {
    epoch: u64,
    payload: DayIntelligencePayload,
}

#[derive(Clone)]
struct RetrievalQueryParts {
    phrases: Vec<String>,
    terms: Vec<String>,
}

#[derive(Clone)]
struct IndexedTextBundle {
    snippet: String,
    source: String,
    highlight_terms: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedBackupBundle {
    version: i64,
    exported_at: String,
    settings: EncryptedBackupSettings,
    captures: Vec<EncryptedBackupCapture>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedBackupSettings {
    interval_minutes: i64,
    retention_days: i64,
    storage_cap_gb: f64,
    is_paused: bool,
    startup_on_boot: bool,
    theme_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedBackupCapture {
    id: i64,
    day_key: String,
    captured_at: String,
    capture_note: String,
    #[serde(default)]
    window_title: String,
    #[serde(default)]
    process_name: String,
    width: i64,
    height: i64,
    relative_image_path: String,
    relative_thumbnail_path: String,
    image_data_base64: String,
    thumbnail_data_base64: String,
    ocr_text: String,
    search_text: String,
    ocr_status: String,
    ocr_error: Option<String>,
    indexed_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureContextPagePayload {
    day_key: String,
    total_captures: i64,
    offset: i64,
    focused_capture_id: i64,
    captures: Vec<DayCapturePayload>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrHealthPayload {
    engine_available: bool,
    status_message: String,
    executable_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReindexCapturesPayload {
    queued_count: i64,
    queued_at: String,
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
            startup_on_boot INTEGER NOT NULL DEFAULT 0,
            theme_id TEXT NOT NULL DEFAULT ''
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

        CREATE TABLE IF NOT EXISTS capture_search_index (
            capture_id INTEGER PRIMARY KEY,
            ocr_text TEXT NOT NULL DEFAULT '',
            search_text TEXT NOT NULL DEFAULT '',
            ocr_status TEXT NOT NULL DEFAULT 'pending',
            ocr_error TEXT,
            indexed_at TEXT,
            FOREIGN KEY(capture_id) REFERENCES captures(id)
        );

        CREATE INDEX IF NOT EXISTS idx_captures_day_time ON captures(day_key, captured_at);
        CREATE INDEX IF NOT EXISTS idx_capture_search_status ON capture_search_index(ocr_status);
        ",
    )
    .map_err(|error| format!("failed to initialize database schema: {error}"))?;

    let existing_settings_count = conn
        .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0);

    // Support existing databases created before the startup_on_boot column existed.
    let _ = conn.execute(
        "ALTER TABLE settings ADD COLUMN startup_on_boot INTEGER NOT NULL DEFAULT 0",
        [],
    );

    // Support existing databases created before theme persistence was introduced.
    let _ = conn.execute(
        "ALTER TABLE settings ADD COLUMN theme_id TEXT NOT NULL DEFAULT ''",
        [],
    );

    // Support existing databases created before capture_note was introduced.
    let _ = conn.execute(
        "ALTER TABLE captures ADD COLUMN capture_note TEXT NOT NULL DEFAULT ''",
        [],
    );

    // Support existing databases created before window/process metadata columns were introduced.
    let _ = conn.execute(
        "ALTER TABLE captures ADD COLUMN window_title TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE captures ADD COLUMN process_name TEXT NOT NULL DEFAULT ''",
        [],
    );

    // Support existing databases created before capture search indexing was introduced.
    let _ = conn.execute(
        "ALTER TABLE capture_search_index ADD COLUMN ocr_text TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE capture_search_index ADD COLUMN search_text TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE capture_search_index ADD COLUMN ocr_status TEXT NOT NULL DEFAULT 'pending'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE capture_search_index ADD COLUMN ocr_error TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE capture_search_index ADD COLUMN indexed_at TEXT",
        [],
    );

    conn.execute(
        "
        INSERT INTO settings (id, interval_minutes, retention_days, storage_cap_gb, is_paused, startup_on_boot, theme_id)
        VALUES (1, ?, ?, ?, 0, 0, '')
        ON CONFLICT(id) DO NOTHING
        ",
        params![
            DEFAULT_INTERVAL_MINUTES,
            DEFAULT_RETENTION_DAYS,
            DEFAULT_STORAGE_CAP_GB
        ],
    )
    .map_err(|error| format!("failed to seed default settings: {error}"))?;

    if existing_settings_count > 0 {
        conn.execute(
            "
            UPDATE settings
            SET theme_id = ?
            WHERE id = 1
              AND (theme_id IS NULL OR trim(theme_id) = '')
            ",
            params![LEGACY_THEME_ID],
        )
        .map_err(|error| format!("failed to migrate legacy theme value: {error}"))?;
    }

    conn.execute(
        "
        INSERT INTO capture_search_index (capture_id, ocr_text, search_text, ocr_status)
        SELECT
            captures.id,
            '',
            lower(
                trim(
                    captures.capture_note || ' ' || captures.window_title || ' ' || captures.process_name
                )
            ),
            'pending'
        FROM captures
        WHERE NOT EXISTS (
            SELECT 1
            FROM capture_search_index
            WHERE capture_search_index.capture_id = captures.id
        )
        ",
        [],
    )
    .map_err(|error| format!("failed to seed capture search index rows: {error}"))?;

    Ok(())
}

fn normalize_theme_id(raw_theme_id: &str) -> Result<String, String> {
    let normalized = raw_theme_id.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("themeId cannot be empty".to_string());
    }

    if VALID_THEME_IDS.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(format!("unsupported themeId: {normalized}"))
    }
}

fn read_settings(conn: &Connection) -> Result<Settings, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT interval_minutes, retention_days, storage_cap_gb, is_paused, startup_on_boot, theme_id
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
                theme_id: row.get(5)?,
            })
        })
        .map_err(|error| format!("failed to read settings: {error}"))?;

    Ok(settings)
}

fn write_settings(conn: &Connection, settings: &Settings) -> Result<(), String> {
    conn.execute(
        "
        UPDATE settings
        SET interval_minutes = ?, retention_days = ?, storage_cap_gb = ?, is_paused = ?, startup_on_boot = ?, theme_id = ?
        WHERE id = 1
        ",
        params![
            settings.interval_minutes,
            settings.retention_days,
            settings.storage_cap_gb,
            if settings.is_paused { 1 } else { 0 },
            if settings.startup_on_boot { 1 } else { 0 },
            settings.theme_id
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

fn trim_cache_to_capacity<T>(cache: &mut HashMap<String, T>, capacity: usize) {
    if cache.len() <= capacity {
        return;
    }

    let overflow = cache.len().saturating_sub(capacity);
    let keys_to_remove = cache
        .keys()
        .take(overflow)
        .cloned()
        .collect::<Vec<_>>();

    for key in keys_to_remove {
        cache.remove(&key);
    }
}

fn bump_indexing_epoch(state: &SharedState) {
    state.indexing_epoch.fetch_add(1, Ordering::Relaxed);

    if let Ok(mut cache) = state.search_cache.lock() {
        cache.clear();
    }

    if let Ok(mut cache) = state.intelligence_cache.lock() {
        cache.clear();
    }
}

fn update_performance_stats(state: &SharedState, f: impl FnOnce(&mut PerformanceStats)) {
    if let Ok(mut stats) = state.performance_stats.lock() {
        f(&mut stats);
    }
}

fn performance_snapshot_payload(state: &SharedState) -> PerformanceSnapshotPayload {
    let stats = state
        .performance_stats
        .lock()
        .ok()
        .map(|guard| (*guard).clone())
        .unwrap_or_default();

    PerformanceSnapshotPayload {
        last_search_ms: stats.last_search_ms,
        last_intelligence_ms: stats.last_intelligence_ms,
        search_cache_hits: stats.search_cache_hits,
        intelligence_cache_hits: stats.intelligence_cache_hits,
    }
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_clock_minutes(token: &str, next_token: Option<&str>) -> Option<i64> {
    let mut normalized = token
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ':')
        .to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    let mut meridiem: Option<String> = None;
    if normalized.ends_with("am") || normalized.ends_with("pm") {
        let suffix = normalized.split_off(normalized.len() - 2);
        meridiem = Some(suffix);
    } else if let Some(next) = next_token {
        let next_normalized = next
            .trim_matches(|c: char| !c.is_ascii_alphanumeric())
            .to_ascii_lowercase();
        if next_normalized == "am" || next_normalized == "pm" {
            meridiem = Some(next_normalized);
        }
    }

    let (hour_raw, minute_raw) = if let Some((hour, minute)) = normalized.split_once(':') {
        (hour.parse::<i64>().ok()?, minute.parse::<i64>().ok()?)
    } else {
        (normalized.parse::<i64>().ok()?, 0)
    };

    if minute_raw < 0 || minute_raw >= 60 {
        return None;
    }

    let hour = if let Some(period) = meridiem {
        if hour_raw <= 0 || hour_raw > 12 {
            return None;
        }

        if period == "am" {
            if hour_raw == 12 { 0 } else { hour_raw }
        } else if hour_raw == 12 {
            12
        } else {
            hour_raw + 12
        }
    } else {
        if !(0..=23).contains(&hour_raw) {
            return None;
        }
        hour_raw
    };

    Some(hour * 60 + minute_raw)
}

fn normalize_token(token: &str) -> String {
    token
        .trim_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_ascii_lowercase()
}

fn stopwords() -> HashSet<&'static str> {
    [
        "what",
        "was",
        "doing",
        "around",
        "at",
        "on",
        "in",
        "the",
        "yesterday",
        "today",
        "am",
        "pm",
        "my",
        "and",
        "for",
        "from",
        "with",
        "then",
        "that",
        "this",
        "into",
        "have",
        "had",
    ]
    .into_iter()
    .collect()
}

fn parse_retrieval_query_parts(query: &str) -> RetrievalQueryParts {
    let lowered = query.to_ascii_lowercase();
    let mut phrases = Vec::<String>::new();
    let mut outside = String::new();
    let mut current_phrase = String::new();
    let mut in_quotes = false;

    for character in lowered.chars() {
        if character == '"' {
            if in_quotes {
                let phrase = collapse_whitespace(&current_phrase);
                if phrase.len() >= 2 {
                    phrases.push(phrase);
                }
                current_phrase.clear();
                in_quotes = false;
            } else {
                in_quotes = true;
            }
            continue;
        }

        if in_quotes {
            current_phrase.push(character);
        } else {
            outside.push(character);
        }
    }

    if in_quotes {
        outside.push(' ');
        outside.push_str(&current_phrase);
    }

    let words = outside
        .split_whitespace()
        .map(normalize_token)
        .filter(|token| token.len() >= 2)
        .collect::<Vec<_>>();

    // Treat plain multi-word queries as an implied phrase so space-containing
    // searches can match contiguous OCR/note text without requiring quotes.
    if words.len() >= 2 {
        phrases.push(words.join(" "));
    }

    let stopwords = stopwords();
    let mut terms = Vec::<String>::new();

    for token in words {
        if !stopwords.contains(token.as_str()) {
            terms.push(token);
        }
    }

    let mut seen = HashSet::<String>::new();
    let mut deduped_phrases = Vec::<String>::new();
    for phrase in phrases {
        if seen.insert(phrase.clone()) {
            deduped_phrases.push(phrase);
        }
    }

    seen.clear();
    let mut deduped_terms = Vec::<String>::new();
    for term in terms {
        if seen.insert(term.clone()) {
            deduped_terms.push(term);
        }
    }

    RetrievalQueryParts {
        phrases: deduped_phrases,
        terms: deduped_terms,
    }
}

fn extract_keywords_for_intelligence(text: &str) -> Vec<String> {
    let stopwords = stopwords();

    text.split_whitespace()
        .map(normalize_token)
        .filter(|token| token.len() >= 3 && !stopwords.contains(token.as_str()))
        .collect()
}

fn settings_to_payload(settings: Settings) -> SettingsPayload {
    SettingsPayload {
        interval_minutes: settings.interval_minutes,
        retention_days: settings.retention_days,
        storage_cap_gb: settings.storage_cap_gb,
        is_paused: settings.is_paused,
        startup_on_boot: settings.startup_on_boot,
        startup_on_boot_supported: startup_on_boot_supported(),
        theme_id: settings.theme_id,
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

fn to_timestamp_label(captured_at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(captured_at)
        .map(|dt| dt.with_timezone(&Local).format("%I:%M %p").to_string())
        .unwrap_or_else(|_| captured_at.to_string())
}

#[cfg(target_os = "windows")]
fn capture_foreground_window_metadata() -> WindowContextMetadata {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return WindowContextMetadata::default();
        }

        let title_length = GetWindowTextLengthW(hwnd);
        let window_title = if title_length > 0 {
            let mut buffer = vec![0_u16; (title_length as usize) + 1];
            let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            if copied > 0 {
                collapse_whitespace(
                    &String::from_utf16_lossy(&buffer[..copied as usize])
                        .trim()
                        .to_string(),
                )
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        let mut process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut process_id);

        let process_name = if process_id > 0 {
            let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if !process_handle.is_null() {
                let mut path_buffer = vec![0_u16; 2048];
                let mut path_length: u32 = path_buffer.len() as u32;
                let resolved = QueryFullProcessImageNameW(
                    process_handle,
                    0,
                    path_buffer.as_mut_ptr(),
                    &mut path_length,
                );
                let _ = CloseHandle(process_handle);

                if resolved != 0 && path_length > 0 {
                    let full_path = String::from_utf16_lossy(&path_buffer[..path_length as usize]);
                    let file_name = Path::new(&full_path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or(full_path.as_str());
                    collapse_whitespace(file_name)
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        WindowContextMetadata {
            window_title,
            process_name,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_foreground_window_metadata() -> WindowContextMetadata {
    WindowContextMetadata::default()
}

fn refresh_capture_search_index(
    conn: &Connection,
    capture_id: i64,
    capture_note: &str,
    ocr_text: &str,
    window_title: &str,
    process_name: &str,
    ocr_status: &str,
    ocr_error: Option<&str>,
    indexed_at: Option<&str>,
) -> Result<(), String> {
    let search_text = collapse_whitespace(&format!(
        "{} {} {} {}",
        capture_note, ocr_text, window_title, process_name
    ))
    .to_ascii_lowercase();

    conn.execute(
        "
        INSERT INTO capture_search_index (capture_id, ocr_text, search_text, ocr_status, ocr_error, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(capture_id) DO UPDATE SET
            ocr_text = excluded.ocr_text,
            search_text = excluded.search_text,
            ocr_status = excluded.ocr_status,
            ocr_error = excluded.ocr_error,
            indexed_at = excluded.indexed_at
        ",
        params![capture_id, ocr_text, search_text, ocr_status, ocr_error, indexed_at],
    )
    .map_err(|error| format!("failed to upsert capture search index: {error}"))?;

    Ok(())
}

fn schedule_capture_index(state: SharedState, capture_id: i64) {
    std::thread::spawn(move || {
        let _ = run_capture_index_job(&state, capture_id);
    });
}

fn tesseract_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    for env_key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(prefix) = std::env::var(env_key) {
            let base = PathBuf::from(prefix);
            candidates.push(base.join("Tesseract-OCR").join("tesseract.exe"));
            candidates.push(base.join("tesseract-ocr").join("tesseract.exe"));
        }
    }

    candidates
}

fn resolve_tesseract_executable() -> Option<PathBuf> {
    let default_available = Command::new("tesseract")
        .arg("--version")
        .status()
        .ok()
        .map(|status| status.success())
        .unwrap_or(false);

    if default_available {
        return Some(PathBuf::from("tesseract"));
    }

    for candidate in tesseract_candidate_paths() {
        if !candidate.is_file() {
            continue;
        }

        let available = Command::new(&candidate)
            .arg("--version")
            .status()
            .ok()
            .map(|status| status.success())
            .unwrap_or(false);

        if available {
            return Some(candidate);
        }
    }

    None
}

fn ocr_health_payload() -> OcrHealthPayload {
    match resolve_tesseract_executable() {
        Some(executable) => {
            let executable_label = executable.to_string_lossy().to_string();
            let status_message = if executable_label.eq_ignore_ascii_case("tesseract") {
                "Local OCR engine ready.".to_string()
            } else {
                format!("Local OCR engine ready ({executable_label}).")
            };

            OcrHealthPayload {
                engine_available: true,
                status_message,
                executable_path: Some(executable_label),
            }
        }
        None => OcrHealthPayload {
            engine_available: false,
            status_message:
                "Local OCR engine unavailable: install Tesseract OCR (or restart MemoryLane after install)."
                    .to_string(),
            executable_path: None,
        },
    }
}

fn extract_ocr_text_from_image(image_path: &str) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("memorylane_ocr");
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("failed to prepare OCR temp directory: {error}"))?;

    let output_stem = format!(
        "capture_{}_{}",
        std::process::id(),
        Local::now().timestamp_millis()
    );
    let output_base = temp_dir.join(output_stem);

    let tesseract_executable = resolve_tesseract_executable().ok_or_else(|| {
        "local OCR engine unavailable: install Tesseract OCR (or restart MemoryLane after install)"
            .to_string()
    })?;

    let status = Command::new(&tesseract_executable)
        .arg(image_path)
        .arg(&output_base)
        .arg("--dpi")
        .arg("96")
        .arg("--psm")
        .arg("6")
        .arg("-l")
        .arg("eng")
        .status();

    match status {
        Ok(code) if code.success() => {}
        Ok(code) => {
            return Err(format!(
                "local OCR engine failed (tesseract exit code {:?})",
                code.code()
            ))
        }
        Err(error) => {
            return Err(format!("failed to execute local OCR engine: {error}"));
        }
    }

    let text_path = output_base.with_extension("txt");
    let text = fs::read_to_string(&text_path)
        .map_err(|error| format!("failed reading OCR output {}: {error}", text_path.display()))?;

    let _ = fs::remove_file(&text_path);

    Ok(collapse_whitespace(&text))
}

fn run_capture_index_job(state: &SharedState, capture_id: i64) -> Result<(), String> {
    let (capture_note, image_path, window_title, process_name) = with_connection(state, |conn| {
        conn.query_row(
            "SELECT capture_note, image_path, window_title, process_name FROM captures WHERE id = ?",
            params![capture_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|error| format!("failed to load capture row for indexing: {error}"))
    })?;

    let processing_at = Local::now().to_rfc3339();
    with_connection(state, |conn| {
        refresh_capture_search_index(
            conn,
            capture_id,
            &capture_note,
            "",
            &window_title,
            &process_name,
            "processing",
            None,
            Some(&processing_at),
        )
    })?;

    let ocr_result = extract_ocr_text_from_image(&image_path);
    let indexed_at = Local::now().to_rfc3339();

    match ocr_result {
        Ok(ocr_text) => {
            with_connection(state, |conn| {
                refresh_capture_search_index(
                    conn,
                    capture_id,
                    &capture_note,
                    &ocr_text,
                    &window_title,
                    &process_name,
                    "ready",
                    None,
                    Some(&indexed_at),
                )
            })?;

            bump_indexing_epoch(state);
            Ok(())
        }
        Err(error) => {
            with_connection(state, |conn| {
                refresh_capture_search_index(
                    conn,
                    capture_id,
                    &capture_note,
                    "",
                    &window_title,
                    &process_name,
                    "error",
                    Some(&error),
                    Some(&indexed_at),
                )
            })?;
            bump_indexing_epoch(state);
            Err(error)
        }
    }
}

#[derive(Clone)]
struct RetrievalTimeHint {
    day_key: Option<String>,
    target_minutes: Option<i64>,
    window_minutes: i64,
}

fn parse_retrieval_time_hint(query: &str) -> RetrievalTimeHint {
    let normalized = query.to_ascii_lowercase();
    let today = Local::now().date_naive();

    let day_key = if normalized.contains("yesterday") {
        Some((today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
    } else if normalized.contains("today") {
        Some(today.format("%Y-%m-%d").to_string())
    } else {
        None
    };

    let window_minutes = if normalized.contains("around") { 75 } else { 45 };
    let tokens: Vec<&str> = normalized.split_whitespace().collect();

    for (index, token) in tokens.iter().enumerate() {
        if let Some(minutes) = parse_clock_minutes(token, tokens.get(index + 1).copied()) {
            return RetrievalTimeHint {
                day_key,
                target_minutes: Some(minutes),
                window_minutes,
            };
        }
    }

    RetrievalTimeHint {
        day_key,
        target_minutes: None,
        window_minutes,
    }
}

fn local_minutes_of_day(captured_at: &str) -> Option<i64> {
    let local = chrono::DateTime::parse_from_rfc3339(captured_at)
        .ok()?
        .with_timezone(&Local);

    Some((local.hour() as i64) * 60 + local.minute() as i64)
}

fn circular_minute_distance(target: i64, value: i64) -> i64 {
    let difference = (target - value).abs();
    difference.min(1440 - difference)
}

fn build_context_snippet(text: &str, match_start: usize, match_len: usize) -> String {
    if text.is_empty() {
        return String::new();
    }

    let prefix_chars = text[..match_start].chars().count();
    let matched_chars = text[match_start..match_start + match_len].chars().count();
    let total_chars = text.chars().count();
    let start_char = prefix_chars.saturating_sub(30);
    let end_char = (prefix_chars + matched_chars + 72).min(total_chars);

    let mut snippet = text
        .chars()
        .skip(start_char)
        .take(end_char.saturating_sub(start_char))
        .collect::<String>();

    snippet = collapse_whitespace(&snippet);
    if start_char > 0 {
        snippet = format!("...{snippet}");
    }

    if end_char < total_chars {
        snippet.push_str("...");
    }

    snippet
}

fn build_retrieval_snippet(
    note: &str,
    ocr_text: &str,
    window_title: &str,
    process_name: &str,
    query_parts: &RetrievalQueryParts,
    fallback_reason: &str,
) -> IndexedTextBundle {
    let note_lower = note.to_ascii_lowercase();
    let ocr_lower = ocr_text.to_ascii_lowercase();
    let window_lower = window_title.to_ascii_lowercase();
    let process_lower = process_name.to_ascii_lowercase();

    let mut probes = query_parts.phrases.clone();
    probes.extend(query_parts.terms.clone());

    for probe in &probes {
        if let Some(index) = note_lower.find(probe) {
            let snippet = build_context_snippet(note, index, probe.len());
            return IndexedTextBundle {
                snippet: format!("Note: {snippet}"),
                source: "note".to_string(),
                highlight_terms: vec![probe.to_string()],
            };
        }

        if let Some(index) = ocr_lower.find(probe) {
            let snippet = build_context_snippet(ocr_text, index, probe.len());
            return IndexedTextBundle {
                snippet: format!("OCR: {snippet}"),
                source: "ocr".to_string(),
                highlight_terms: vec![probe.to_string()],
            };
        }

        if let Some(index) = window_lower.find(probe) {
            let snippet = build_context_snippet(window_title, index, probe.len());
            return IndexedTextBundle {
                snippet: format!("Window: {snippet}"),
                source: "window".to_string(),
                highlight_terms: vec![probe.to_string()],
            };
        }

        if let Some(index) = process_lower.find(probe) {
            let snippet = build_context_snippet(process_name, index, probe.len());
            return IndexedTextBundle {
                snippet: format!("App: {snippet}"),
                source: "window".to_string(),
                highlight_terms: vec![probe.to_string()],
            };
        }
    }

    if !note.trim().is_empty() {
        return IndexedTextBundle {
            snippet: format!("Note: {}", collapse_whitespace(note)),
            source: "note".to_string(),
            highlight_terms: Vec::new(),
        };
    }

    if !ocr_text.trim().is_empty() {
        let shortened = ocr_text.trim().chars().take(160).collect::<String>();
        return IndexedTextBundle {
            snippet: format!("OCR: {}", collapse_whitespace(&shortened)),
            source: "ocr".to_string(),
            highlight_terms: Vec::new(),
        };
    }

    if !window_title.trim().is_empty() {
        return IndexedTextBundle {
            snippet: format!("Window: {}", collapse_whitespace(window_title)),
            source: "window".to_string(),
            highlight_terms: Vec::new(),
        };
    }

    if !process_name.trim().is_empty() {
        return IndexedTextBundle {
            snippet: format!("App: {}", collapse_whitespace(process_name)),
            source: "window".to_string(),
            highlight_terms: Vec::new(),
        };
    }

    IndexedTextBundle {
        snippet: fallback_reason.to_string(),
        source: "metadata".to_string(),
        highlight_terms: Vec::new(),
    }
}

fn collect_matched_tokens(text_lower: &str, query_parts: &RetrievalQueryParts) -> Vec<String> {
    let mut matched = Vec::<String>::new();

    for phrase in &query_parts.phrases {
        if text_lower.contains(phrase) {
            matched.push(phrase.clone());
        }
    }

    for term in &query_parts.terms {
        if text_lower.contains(term) {
            matched.push(term.clone());
        }
    }

    let mut seen = HashSet::<String>::new();
    matched
        .into_iter()
        .filter(|token| seen.insert(token.clone()))
        .collect()
}

fn lexical_density_score(text_lower: &str, query_parts: &RetrievalQueryParts) -> f64 {
    let mut score = 0.0;

    for phrase in &query_parts.phrases {
        if text_lower.contains(phrase) {
            score += 1.0;
        }
    }

    for term in &query_parts.terms {
        if text_lower.contains(term) {
            score += 0.35;
        }
    }

    score
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

fn build_day_intelligence_payload(
    day_key: &str,
    rows: &[(String, String, String)],
    generation_ms: i64,
) -> DayIntelligencePayload {
    if rows.is_empty() {
        return DayIntelligencePayload {
            day_key: day_key.to_string(),
            summary: "No captures available for this day yet.".to_string(),
            focus_blocks: Vec::new(),
            change_highlights: Vec::new(),
            top_terms: Vec::new(),
            generated_at: Local::now().to_rfc3339(),
            generation_ms,
        };
    }

    let mut clusters = Vec::<(usize, usize)>::new();
    let mut start = 0_usize;

    for index in 1..rows.len() {
        let previous = chrono::DateTime::parse_from_rfc3339(&rows[index - 1].0)
            .ok()
            .map(|dt| dt.with_timezone(&Local));
        let current = chrono::DateTime::parse_from_rfc3339(&rows[index].0)
            .ok()
            .map(|dt| dt.with_timezone(&Local));

        let Some(previous) = previous else {
            continue;
        };
        let Some(current) = current else {
            continue;
        };

        let gap_minutes = (current - previous).num_minutes();
        if gap_minutes >= INTELLIGENCE_SESSION_GAP_MINUTES {
            clusters.push((start, index - 1));
            start = index;
        }
    }
    clusters.push((start, rows.len() - 1));

    let mut global_frequency = HashMap::<String, i64>::new();
    let mut focus_blocks = Vec::<DayFocusBlockPayload>::new();
    let mut block_terms = Vec::<HashSet<String>>::new();

    for (block_start, block_end) in &clusters {
        let mut block_frequency = HashMap::<String, i64>::new();
        let mut terms_set = HashSet::<String>::new();

        for row in &rows[*block_start..=*block_end] {
            let merged = format!("{} {}", row.1, row.2);
            for token in extract_keywords_for_intelligence(&merged) {
                *global_frequency.entry(token.clone()).or_insert(0) += 1;
                *block_frequency.entry(token.clone()).or_insert(0) += 1;
                terms_set.insert(token);
            }
        }

        let mut block_keywords = block_frequency.into_iter().collect::<Vec<_>>();
        block_keywords.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

        let dominant_context = if block_keywords.is_empty() {
            "General workspace review".to_string()
        } else {
            block_keywords
                .iter()
                .take(2)
                .map(|(term, _)| term.to_string())
                .collect::<Vec<_>>()
                .join(" + ")
        };

        focus_blocks.push(DayFocusBlockPayload {
            start_timestamp_label: to_timestamp_label(&rows[*block_start].0),
            end_timestamp_label: to_timestamp_label(&rows[*block_end].0),
            capture_count: (*block_end as i64) - (*block_start as i64) + 1,
            dominant_context,
        });
        block_terms.push(terms_set);
    }

    let mut top_terms = global_frequency.into_iter().collect::<Vec<_>>();
    top_terms.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let top_term_labels = top_terms
        .into_iter()
        .take(6)
        .map(|(term, _)| term)
        .collect::<Vec<_>>();

    let mut change_highlights = Vec::<String>::new();
    for index in 1..focus_blocks.len() {
        let previous_terms = &block_terms[index - 1];
        let current_terms = &block_terms[index];
        let newly_introduced = current_terms
            .iter()
            .filter(|term| !previous_terms.contains(*term))
            .take(2)
            .cloned()
            .collect::<Vec<_>>();

        let highlight = if newly_introduced.is_empty() {
            format!(
                "{} to {} stayed on similar context.",
                focus_blocks[index].start_timestamp_label, focus_blocks[index].end_timestamp_label
            )
        } else {
            format!(
                "{} introduced {}.",
                focus_blocks[index].start_timestamp_label,
                newly_introduced.join(" + ")
            )
        };

        change_highlights.push(highlight);
    }

    if change_highlights.is_empty() {
        change_highlights.push("Single focus block detected for this day.".to_string());
    }

    let first_label = rows
        .first()
        .map(|row| to_timestamp_label(&row.0))
        .unwrap_or_else(|| "unknown".to_string());
    let last_label = rows
        .last()
        .map(|row| to_timestamp_label(&row.0))
        .unwrap_or_else(|| "unknown".to_string());

    let summary = if top_term_labels.is_empty() {
        format!(
            "{} captures between {} and {} across {} focus block(s).",
            rows.len(),
            first_label,
            last_label,
            focus_blocks.len()
        )
    } else {
        let themes = top_term_labels
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{} captures between {} and {} across {} focus block(s). Top themes: {}.",
            rows.len(),
            first_label,
            last_label,
            focus_blocks.len(),
            themes
        )
    };

    DayIntelligencePayload {
        day_key: day_key.to_string(),
        summary,
        focus_blocks,
        change_highlights,
        top_terms: top_term_labels,
        generated_at: Local::now().to_rfc3339(),
        generation_ms,
    }
}

fn derive_backup_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    if passphrase.trim().len() < 8 {
        return Err("backup passphrase must be at least 8 characters".to_string());
    }

    let mut key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, BACKUP_KDF_ROUNDS, &mut key);
    Ok(key)
}

fn encrypt_backup_payload(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut salt = [0_u8; BACKUP_SALT_LEN];
    let mut nonce_bytes = [0_u8; BACKUP_NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);

    let key = derive_backup_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("failed to initialize backup cipher: {error}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| "failed to encrypt backup payload".to_string())?;

    let mut output = Vec::with_capacity(
        BACKUP_MAGIC.len() + BACKUP_SALT_LEN + BACKUP_NONCE_LEN + ciphertext.len(),
    );
    output.extend_from_slice(BACKUP_MAGIC);
    output.extend_from_slice(&salt);
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

fn decrypt_backup_payload(passphrase: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
    let minimum_length = BACKUP_MAGIC.len() + BACKUP_SALT_LEN + BACKUP_NONCE_LEN + 1;
    if payload.len() < minimum_length {
        return Err("backup file is too short or corrupted".to_string());
    }

    if &payload[..BACKUP_MAGIC.len()] != BACKUP_MAGIC {
        return Err("backup header mismatch".to_string());
    }

    let salt_start = BACKUP_MAGIC.len();
    let nonce_start = salt_start + BACKUP_SALT_LEN;
    let cipher_start = nonce_start + BACKUP_NONCE_LEN;

    let salt = &payload[salt_start..nonce_start];
    let nonce_bytes = &payload[nonce_start..cipher_start];
    let ciphertext = &payload[cipher_start..];

    let key = derive_backup_key(passphrase, salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("failed to initialize backup cipher: {error}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "failed to decrypt backup: incorrect passphrase or corrupted file".to_string())
}

fn normalize_backup_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(relative_path.replace('\\', "/"));

    for component in path.components() {
        if matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            return Err("backup contains invalid relative path".to_string());
        }
    }

    Ok(path)
}

fn relative_capture_path(
    capture_dir: &Path,
    absolute_path: &str,
    day_key: &str,
    fallback_suffix: &str,
) -> String {
    let as_path = Path::new(absolute_path);
    if let Ok(stripped) = as_path.strip_prefix(capture_dir) {
        return stripped
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
    }

    let file_name = as_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback_suffix)
        .to_string();
    format!("{day_key}/{file_name}")
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

        conn.execute(
            "DELETE FROM capture_search_index WHERE capture_id IN (SELECT id FROM captures WHERE day_key = ?)",
            params![day_key],
        )
        .map_err(|error| format!("failed to delete day search index rows: {error}"))?;

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
        conn.execute(
            "DELETE FROM capture_search_index WHERE capture_id = ?",
            params![capture_id],
        )
        .map_err(|error| format!("failed to delete capture search index row: {error}"))?;

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
    let mut removed_any = false;

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
                removed_any = true;
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
                removed_any = true;
            }
            None => break,
        }
    }

    if removed_any {
        bump_indexing_epoch(state);
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
    let window_context = capture_foreground_window_metadata();
    let window_title = window_context.window_title;
    let process_name = window_context.process_name;
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

    let capture_id = with_connection(state, |conn| {
        conn.execute(
            "
            INSERT INTO captures (
                day_key,
                captured_at,
                image_path,
                thumbnail_path,
                capture_note,
                window_title,
                process_name,
                width,
                height
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                day_key,
                now.to_rfc3339(),
                image_path.to_string_lossy().to_string(),
                thumbnail_path.to_string_lossy().to_string(),
                "",
                window_title,
                process_name,
                screenshot.width() as i64,
                screenshot.height() as i64
            ],
        )
        .map_err(|error| format!("failed to persist capture metadata: {error}"))?;

        let inserted_capture_id = conn.last_insert_rowid();
        refresh_capture_search_index(
            conn,
            inserted_capture_id,
            "",
            "",
            &window_title,
            &process_name,
            "pending",
            None,
            None,
        )?;

        Ok(inserted_capture_id)
    })?;

    bump_indexing_epoch(state);

    schedule_capture_index(state.clone(), capture_id);

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
    let tray_icon_rgba = image::load_from_memory_with_format(
        include_bytes!("../icons/icon.png"),
        image::ImageFormat::Png,
    )
    .map_err(|error| format!("failed to decode tray logo png: {error}"))?
    .to_rgba8();
    let (tray_icon_width, tray_icon_height) = tray_icon_rgba.dimensions();
    let tray_icon = tauri::image::Image::new_owned(
        tray_icon_rgba.into_raw(),
        tray_icon_width,
        tray_icon_height,
    );

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
        .icon(tray_icon)
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
    theme_id: Option<String>,
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

        if let Some(theme) = theme_id {
            settings.theme_id = normalize_theme_id(&theme)?;
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
fn get_fullscreen_state(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    window
        .is_fullscreen()
        .map_err(|error| format!("failed to read fullscreen state: {error}"))
}

#[tauri::command]
fn toggle_fullscreen(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let next_fullscreen_state = !window
        .is_fullscreen()
        .map_err(|error| format!("failed to read fullscreen state: {error}"))?;

    window
        .set_fullscreen(next_fullscreen_state)
        .map_err(|error| format!("failed to set fullscreen state: {error}"))?;

    Ok(next_fullscreen_state)
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

    load_day_captures_page(&state, &day_key, safe_offset, safe_limit)
}

fn load_day_captures_page(
    state: &SharedState,
    day_key: &str,
    offset: i64,
    limit: i64,
) -> Result<Vec<DayCapturePayload>, String> {
    let safe_offset = offset.max(0);
    let safe_limit = limit.clamp(1, 1000);

    let rows = with_connection(&state, |conn| {
        let mut stmt = conn
            .prepare(
                "
                SELECT
                    captures.id,
                    captures.day_key,
                    captures.captured_at,
                    captures.image_path,
                    captures.thumbnail_path,
                    captures.capture_note,
                    captures.window_title,
                    captures.process_name,
                    captures.width,
                    captures.height,
                    COALESCE(capture_search_index.ocr_text, '')
                FROM captures
                LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
                WHERE captures.day_key = ?
                ORDER BY captures.captured_at ASC
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
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .map_err(|error| format!("failed to run day captures query: {error}"))?;

        let mut capture_rows = Vec::new();

        for row in rows {
            let (
                id,
                row_day_key,
                captured_at,
                image_path,
                thumbnail_path,
                capture_note,
                window_title,
                process_name,
                width,
                height,
                ocr_text,
            ) = row.map_err(|error| format!("failed to read capture row: {error}"))?;

            capture_rows.push((
                id,
                row_day_key,
                captured_at,
                image_path,
                thumbnail_path,
                capture_note,
                window_title,
                process_name,
                width,
                height,
                ocr_text,
            ));
        }

        Ok(capture_rows)
    })?;

    let mut captures = Vec::new();

    for (
        id,
        row_day_key,
        captured_at,
        image_path,
        thumbnail_path,
        capture_note,
        window_title,
        process_name,
        width,
        height,
        ocr_text,
    ) in rows
    {
        let timestamp_label = to_timestamp_label(&captured_at);

        captures.push(DayCapturePayload {
            id,
            day_key: row_day_key,
            captured_at,
            timestamp_label,
            image_path,
            thumbnail_data_url: load_image_data_url(&thumbnail_path)?,
            capture_note,
            ocr_text,
            window_title,
            process_name,
            width,
            height,
        });
    }

    Ok(captures)
}

#[tauri::command]
fn search_captures(
    state: State<SharedState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<RetrievalSearchResultPayload>, String> {
    let started = Instant::now();
    let normalized_query = collapse_whitespace(query.trim()).to_ascii_lowercase();
    if normalized_query.len() < 2 {
        return Ok(Vec::new());
    }

    let safe_limit = limit.unwrap_or(20).clamp(1, 80) as usize;
    let cache_key = format!("{}::{safe_limit}", normalized_query);
    let epoch = state.indexing_epoch.load(Ordering::Relaxed);

    if let Ok(cache) = state.search_cache.lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.epoch == epoch {
                update_performance_stats(&state, |stats| {
                    stats.search_cache_hits = stats.search_cache_hits.saturating_add(1);
                    stats.last_search_ms = started.elapsed().as_millis() as i64;
                });
                return Ok(entry.results.clone());
            }
        }
    }

    let time_hint = parse_retrieval_time_hint(&normalized_query);
    let query_parts = parse_retrieval_query_parts(&normalized_query);
    let has_text_query = !query_parts.terms.is_empty() || !query_parts.phrases.is_empty();

    if !has_text_query && time_hint.target_minutes.is_none() && time_hint.day_key.is_none() {
        return Ok(Vec::new());
    }

    let rows = with_connection(&state, |conn| {
        let sql = if time_hint.day_key.is_some() {
            "
            SELECT
                captures.id,
                captures.day_key,
                captures.captured_at,
                captures.capture_note,
                captures.window_title,
                captures.process_name,
                COALESCE(capture_search_index.ocr_text, '')
            FROM captures
            LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
            WHERE captures.day_key = ?
            ORDER BY captures.captured_at DESC
            LIMIT 2000
            "
        } else {
            "
            SELECT
                captures.id,
                captures.day_key,
                captures.captured_at,
                captures.capture_note,
                captures.window_title,
                captures.process_name,
                COALESCE(capture_search_index.ocr_text, '')
            FROM captures
            LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
            ORDER BY captures.captured_at DESC
            LIMIT 2000
            "
        };

        let mut stmt = conn
            .prepare(sql)
            .map_err(|error| format!("failed to prepare capture search query: {error}"))?;

        let mut collected = Vec::new();

        if let Some(day_key) = &time_hint.day_key {
            let rows = stmt
                .query_map(params![day_key], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .map_err(|error| format!("failed to execute day-constrained capture search: {error}"))?;

            for row in rows {
                collected.push(row.map_err(|error| format!("failed to read capture search row: {error}"))?);
            }
        } else {
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .map_err(|error| format!("failed to execute capture search: {error}"))?;

            for row in rows {
                collected.push(row.map_err(|error| format!("failed to read capture search row: {error}"))?);
            }
        }

        Ok(collected)
    })?;

    let mut results = Vec::<RetrievalSearchResultPayload>::new();

    for (capture_id, day_key, captured_at, capture_note, window_title, process_name, ocr_text) in rows {
        let note_lower = capture_note.to_ascii_lowercase();
        let ocr_lower = ocr_text.to_ascii_lowercase();
        let window_lower = window_title.to_ascii_lowercase();
        let process_lower = process_name.to_ascii_lowercase();
        let mut score = 0.0;
        let mut reasons = Vec::<String>::new();
        let mut highlight_terms = HashSet::<String>::new();

        let note_phrase_hits = query_parts
            .phrases
            .iter()
            .filter(|phrase| note_lower.contains(phrase.as_str()))
            .count() as i64;
        let ocr_phrase_hits = query_parts
            .phrases
            .iter()
            .filter(|phrase| ocr_lower.contains(phrase.as_str()))
            .count() as i64;
        let window_phrase_hits = query_parts
            .phrases
            .iter()
            .filter(|phrase| window_lower.contains(phrase.as_str()))
            .count() as i64;
        let process_phrase_hits = query_parts
            .phrases
            .iter()
            .filter(|phrase| process_lower.contains(phrase.as_str()))
            .count() as i64;
        let note_term_hits = query_parts
            .terms
            .iter()
            .filter(|term| note_lower.contains(term.as_str()))
            .count() as i64;
        let ocr_term_hits = query_parts
            .terms
            .iter()
            .filter(|term| ocr_lower.contains(term.as_str()))
            .count() as i64;
        let window_term_hits = query_parts
            .terms
            .iter()
            .filter(|term| window_lower.contains(term.as_str()))
            .count() as i64;
        let process_term_hits = query_parts
            .terms
            .iter()
            .filter(|term| process_lower.contains(term.as_str()))
            .count() as i64;
        let total_text_hits = note_phrase_hits
            + ocr_phrase_hits
            + window_phrase_hits
            + process_phrase_hits
            + note_term_hits
            + ocr_term_hits
            + window_term_hits
            + process_term_hits;

        if has_text_query {
            if total_text_hits == 0 && time_hint.target_minutes.is_none() {
                continue;
            }

            score += (note_phrase_hits as f64) * 8.0;
            score += (ocr_phrase_hits as f64) * 6.2;
            score += (window_phrase_hits as f64) * 4.8;
            score += (process_phrase_hits as f64) * 4.1;
            score += (note_term_hits as f64) * 2.8;
            score += (ocr_term_hits as f64) * 1.9;
            score += (window_term_hits as f64) * 1.6;
            score += (process_term_hits as f64) * 1.3;
            score += lexical_density_score(&note_lower, &query_parts) * 1.6;
            score += lexical_density_score(&ocr_lower, &query_parts) * 1.1;
            score += lexical_density_score(&window_lower, &query_parts) * 0.9;
            score += lexical_density_score(&process_lower, &query_parts) * 0.7;

            if !query_parts.phrases.is_empty()
                && (note_phrase_hits + ocr_phrase_hits + window_phrase_hits + process_phrase_hits)
                    as usize
                    >= query_parts.phrases.len()
            {
                score += 2.4;
                reasons.push("exact phrase".to_string());
            }

            if !query_parts.terms.is_empty()
                && (note_term_hits + ocr_term_hits + window_term_hits + process_term_hits) as usize
                    >= query_parts.terms.len()
            {
                score += 1.6;
                reasons.push("all terms".to_string());
            }

            if note_phrase_hits + note_term_hits > 0 {
                reasons.push("note".to_string());
            }

            if ocr_phrase_hits + ocr_term_hits > 0 {
                reasons.push("ocr".to_string());
            }

            if window_phrase_hits + process_phrase_hits + window_term_hits + process_term_hits > 0 {
                reasons.push("window".to_string());
            }

            for token in collect_matched_tokens(&note_lower, &query_parts) {
                highlight_terms.insert(token);
            }
            for token in collect_matched_tokens(&ocr_lower, &query_parts) {
                highlight_terms.insert(token);
            }
            for token in collect_matched_tokens(&window_lower, &query_parts) {
                highlight_terms.insert(token);
            }
            for token in collect_matched_tokens(&process_lower, &query_parts) {
                highlight_terms.insert(token);
            }
        }

        if let Some(target_minutes) = time_hint.target_minutes {
            let Some(current_minutes) = local_minutes_of_day(&captured_at) else {
                continue;
            };

            let distance = circular_minute_distance(target_minutes, current_minutes);
            if distance > time_hint.window_minutes {
                continue;
            }

            score += 3.4 - (distance as f64 / time_hint.window_minutes as f64) * 1.8;
            reasons.push("time".to_string());
        }

        if let Some(day_filter) = &time_hint.day_key {
            if &day_key == day_filter {
                score += 0.6;
                reasons.push("day".to_string());
            }
        }

        if total_text_hits == 0
            && has_text_query
            && time_hint.target_minutes.is_none()
            && time_hint.day_key.is_none()
        {
            continue;
        }

        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&captured_at) {
            let age_hours = (Local::now() - parsed.with_timezone(&Local)).num_hours().max(0) as f64;
            let recency_bonus = ((72.0 - age_hours).max(0.0) / 72.0) * 0.35;
            score += recency_bonus;
        }

        if reasons.is_empty() {
            reasons.push("metadata".to_string());
        }

        let mut reason_seen = HashSet::<String>::new();
        reasons.retain(|reason| reason_seen.insert(reason.clone()));

        let snippet_bundle = build_retrieval_snippet(
            &capture_note,
            &ocr_text,
            &window_title,
            &process_name,
            &query_parts,
            "Matched by capture metadata.",
        );

        for token in snippet_bundle.highlight_terms {
            highlight_terms.insert(token);
        }

        let mut highlight_terms = highlight_terms.into_iter().collect::<Vec<_>>();
        highlight_terms.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        let match_sources = reasons.clone();

        results.push(RetrievalSearchResultPayload {
            capture_id,
            day_key,
            captured_at: captured_at.clone(),
            timestamp_label: to_timestamp_label(&captured_at),
            snippet: snippet_bundle.snippet,
            match_reason: reasons.join(" · "),
            match_sources,
            score,
            snippet_source: snippet_bundle.source,
            highlight_terms,
        });
    }

    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.captured_at.cmp(&left.captured_at))
    });

    results.truncate(safe_limit);

    if let Ok(mut cache) = state.search_cache.lock() {
        cache.insert(
            cache_key,
            SearchCacheEntry {
                epoch,
                results: results.clone(),
            },
        );
        trim_cache_to_capacity(&mut cache, SEARCH_CACHE_CAPACITY);
    }

    update_performance_stats(&state, |stats| {
        stats.last_search_ms = started.elapsed().as_millis() as i64;
    });

    Ok(results)
}

#[tauri::command]
fn get_day_intelligence(
    state: State<SharedState>,
    day_key: String,
) -> Result<DayIntelligencePayload, String> {
    let started = Instant::now();
    let epoch = state.indexing_epoch.load(Ordering::Relaxed);

    if let Ok(cache) = state.intelligence_cache.lock() {
        if let Some(entry) = cache.get(&day_key) {
            if entry.epoch == epoch {
                update_performance_stats(&state, |stats| {
                    stats.intelligence_cache_hits = stats.intelligence_cache_hits.saturating_add(1);
                    stats.last_intelligence_ms = started.elapsed().as_millis() as i64;
                });
                return Ok(entry.payload.clone());
            }
        }
    }

    let rows = with_connection(&state, |conn| {
        let mut stmt = conn
            .prepare(
                "
                SELECT captures.captured_at, captures.capture_note, COALESCE(capture_search_index.ocr_text, '')
                FROM captures
                LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
                WHERE captures.day_key = ?
                ORDER BY captures.captured_at ASC
                LIMIT 3000
                ",
            )
            .map_err(|error| format!("failed to prepare day intelligence query: {error}"))?;

        let rows = stmt
            .query_map(params![day_key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("failed to execute day intelligence query: {error}"))?;

        let mut collected = Vec::new();
        for row in rows {
            collected.push(row.map_err(|error| format!("failed to read day intelligence row: {error}"))?);
        }

        Ok(collected)
    })?;

    let generation_ms = started.elapsed().as_millis() as i64;
    let payload = build_day_intelligence_payload(&day_key, &rows, generation_ms);

    if let Ok(mut cache) = state.intelligence_cache.lock() {
        cache.insert(
            day_key,
            IntelligenceCacheEntry {
                epoch,
                payload: payload.clone(),
            },
        );
        trim_cache_to_capacity(&mut cache, INTELLIGENCE_CACHE_CAPACITY);
    }

    update_performance_stats(&state, |stats| {
        stats.last_intelligence_ms = generation_ms;
    });

    Ok(payload)
}

#[tauri::command]
fn get_performance_snapshot(state: State<SharedState>) -> PerformanceSnapshotPayload {
    performance_snapshot_payload(&state)
}

#[tauri::command]
fn export_encrypted_backup(state: State<SharedState>, passphrase: String) -> Result<String, String> {
    let settings = with_connection(&state, read_settings)?;

    let capture_rows = with_connection(&state, |conn| {
        let mut stmt = conn
            .prepare(
                "
                SELECT
                    captures.id,
                    captures.day_key,
                    captures.captured_at,
                    captures.image_path,
                    captures.thumbnail_path,
                    captures.capture_note,
                    captures.window_title,
                    captures.process_name,
                    captures.width,
                    captures.height,
                    COALESCE(capture_search_index.ocr_text, ''),
                    COALESCE(capture_search_index.search_text, ''),
                    COALESCE(capture_search_index.ocr_status, 'pending'),
                    capture_search_index.ocr_error,
                    capture_search_index.indexed_at
                FROM captures
                LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
                ORDER BY captures.id ASC
                ",
            )
            .map_err(|error| format!("failed to prepare encrypted backup query: {error}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, Option<String>>(13)?,
                    row.get::<_, Option<String>>(14)?,
                ))
            })
            .map_err(|error| format!("failed to run encrypted backup query: {error}"))?;

        let mut collected = Vec::new();
        for row in rows {
            collected.push(row.map_err(|error| format!("failed to read encrypted backup row: {error}"))?);
        }

        Ok(collected)
    })?;

    let captures = capture_rows
        .into_iter()
        .map(
            |(
                id,
                day_key,
                captured_at,
                image_path,
                thumbnail_path,
                capture_note,
                window_title,
                process_name,
                width,
                height,
                ocr_text,
                search_text,
                ocr_status,
                ocr_error,
                indexed_at,
            )| {
                let image_bytes = fs::read(&image_path)
                    .map_err(|error| format!("failed reading capture image for backup {}: {error}", image_path))?;
                let thumbnail_bytes = fs::read(&thumbnail_path).map_err(|error| {
                    format!(
                        "failed reading capture thumbnail for backup {}: {error}",
                        thumbnail_path
                    )
                })?;

                Ok(EncryptedBackupCapture {
                    id,
                    day_key: day_key.clone(),
                    captured_at,
                    capture_note,
                    window_title,
                    process_name,
                    width,
                    height,
                    relative_image_path: relative_capture_path(
                        &state.capture_dir,
                        &image_path,
                        &day_key,
                        "capture.jpg",
                    ),
                    relative_thumbnail_path: relative_capture_path(
                        &state.capture_dir,
                        &thumbnail_path,
                        &day_key,
                        "capture_thumb.jpg",
                    ),
                    image_data_base64: BASE64.encode(image_bytes),
                    thumbnail_data_base64: BASE64.encode(thumbnail_bytes),
                    ocr_text,
                    search_text,
                    ocr_status,
                    ocr_error,
                    indexed_at,
                })
            },
        )
        .collect::<Result<Vec<_>, String>>()?;

    let bundle = EncryptedBackupBundle {
        version: BACKUP_VERSION,
        exported_at: Local::now().to_rfc3339(),
        settings: EncryptedBackupSettings {
            interval_minutes: settings.interval_minutes,
            retention_days: settings.retention_days,
            storage_cap_gb: settings.storage_cap_gb,
            is_paused: settings.is_paused,
            startup_on_boot: settings.startup_on_boot,
            theme_id: settings.theme_id,
        },
        captures,
    };

    let encoded = serde_json::to_vec(&bundle)
        .map_err(|error| format!("failed to encode encrypted backup payload: {error}"))?;
    let encrypted = encrypt_backup_payload(&passphrase, &encoded)?;

    fs::create_dir_all(&state.backup_dir)
        .map_err(|error| format!("failed to prepare backup directory: {error}"))?;
    let backup_path = state.backup_dir.join(format!(
        "memorylane_backup_{}.mlbk",
        Local::now().format("%Y%m%d_%H%M%S")
    ));
    fs::write(&backup_path, encrypted)
        .map_err(|error| format!("failed to write encrypted backup: {error}"))?;

    Ok(backup_path.to_string_lossy().to_string())
}

#[tauri::command]
fn import_encrypted_backup(
    state: State<SharedState>,
    app: AppHandle,
    backup_path: String,
    passphrase: String,
) -> Result<ImportBackupPayload, String> {
    let encrypted_payload = fs::read(&backup_path)
        .map_err(|error| format!("failed to read encrypted backup file {}: {error}", backup_path))?;
    let decrypted_payload = decrypt_backup_payload(&passphrase, &encrypted_payload)?;
    let bundle: EncryptedBackupBundle = serde_json::from_slice(&decrypted_payload)
        .map_err(|error| format!("failed to decode encrypted backup payload: {error}"))?;

    if bundle.version != BACKUP_VERSION {
        return Err(format!(
            "unsupported backup version {} (expected {})",
            bundle.version, BACKUP_VERSION
        ));
    }

    let restore_staging_dir = state
        .capture_dir
        .parent()
        .unwrap_or(&state.capture_dir)
        .join(format!("captures_restore_staging_{}", Local::now().timestamp()));

    if restore_staging_dir.exists() {
        fs::remove_dir_all(&restore_staging_dir)
            .map_err(|error| format!("failed to clear restore staging directory: {error}"))?;
    }
    fs::create_dir_all(&restore_staging_dir)
        .map_err(|error| format!("failed to create restore staging directory: {error}"))?;

    for capture in &bundle.captures {
        let image_rel = normalize_backup_relative_path(&capture.relative_image_path)?;
        let thumbnail_rel = normalize_backup_relative_path(&capture.relative_thumbnail_path)?;

        let image_path = restore_staging_dir.join(&image_rel);
        let thumbnail_path = restore_staging_dir.join(&thumbnail_rel);
        if let Some(parent) = image_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create restored image parent: {error}"))?;
        }
        if let Some(parent) = thumbnail_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create restored thumbnail parent: {error}"))?;
        }

        let image_bytes = BASE64
            .decode(capture.image_data_base64.as_bytes())
            .map_err(|error| format!("failed decoding restored image payload: {error}"))?;
        let thumbnail_bytes = BASE64
            .decode(capture.thumbnail_data_base64.as_bytes())
            .map_err(|error| format!("failed decoding restored thumbnail payload: {error}"))?;

        fs::write(&image_path, image_bytes)
            .map_err(|error| format!("failed writing restored image file: {error}"))?;
        fs::write(&thumbnail_path, thumbnail_bytes)
            .map_err(|error| format!("failed writing restored thumbnail file: {error}"))?;
    }

    with_connection(&state, |conn| {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| format!("failed to open backup restore transaction: {error}"))?;
        let restored_theme_id = normalize_theme_id(&bundle.settings.theme_id)?;

        transaction
            .execute("DELETE FROM capture_search_index", [])
            .map_err(|error| format!("failed clearing search index rows during restore: {error}"))?;
        transaction
            .execute("DELETE FROM captures", [])
            .map_err(|error| format!("failed clearing capture rows during restore: {error}"))?;
        transaction
            .execute("DELETE FROM settings", [])
            .map_err(|error| format!("failed clearing settings row during restore: {error}"))?;

        transaction
            .execute(
                "
                INSERT INTO settings (id, interval_minutes, retention_days, storage_cap_gb, is_paused, startup_on_boot, theme_id)
                VALUES (1, ?, ?, ?, ?, ?, ?)
                ",
                params![
                    bundle.settings.interval_minutes,
                    bundle.settings.retention_days,
                    bundle.settings.storage_cap_gb,
                    if bundle.settings.is_paused { 1 } else { 0 },
                    if bundle.settings.startup_on_boot { 1 } else { 0 },
                    restored_theme_id
                ],
            )
            .map_err(|error| format!("failed restoring settings row: {error}"))?;

        for capture in &bundle.captures {
            let image_rel = normalize_backup_relative_path(&capture.relative_image_path)?;
            let thumbnail_rel = normalize_backup_relative_path(&capture.relative_thumbnail_path)?;

            let image_path = state
                .capture_dir
                .join(&image_rel)
                .to_string_lossy()
                .to_string();
            let thumbnail_path = state
                .capture_dir
                .join(&thumbnail_rel)
                .to_string_lossy()
                .to_string();

            transaction
                .execute(
                    "
                    INSERT INTO captures (
                        id,
                        day_key,
                        captured_at,
                        image_path,
                        thumbnail_path,
                        capture_note,
                        window_title,
                        process_name,
                        width,
                        height
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ",
                    params![
                        capture.id,
                        capture.day_key,
                        capture.captured_at,
                        image_path,
                        thumbnail_path,
                        capture.capture_note,
                        capture.window_title,
                        capture.process_name,
                        capture.width,
                        capture.height,
                    ],
                )
                .map_err(|error| format!("failed restoring capture row: {error}"))?;

            transaction
                .execute(
                    "
                    INSERT INTO capture_search_index (capture_id, ocr_text, search_text, ocr_status, ocr_error, indexed_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ",
                    params![
                        capture.id,
                        capture.ocr_text,
                        capture.search_text,
                        capture.ocr_status,
                        capture.ocr_error,
                        capture.indexed_at,
                    ],
                )
                .map_err(|error| format!("failed restoring search index row: {error}"))?;
        }

        transaction
            .commit()
            .map_err(|error| format!("failed to commit backup restore transaction: {error}"))?;

        Ok(())
    })?;

    if state.capture_dir.exists() {
        fs::remove_dir_all(&state.capture_dir)
            .map_err(|error| format!("failed clearing existing capture directory before restore: {error}"))?;
    }
    fs::rename(&restore_staging_dir, &state.capture_dir)
        .map_err(|error| format!("failed finalizing restored capture directory: {error}"))?;

    state
        .pause_state
        .store(bundle.settings.is_paused, Ordering::Relaxed);
    bump_indexing_epoch(&state);
    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update after restore: {error}"))?;

    let day_count = bundle
        .captures
        .iter()
        .map(|capture| capture.day_key.clone())
        .collect::<HashSet<_>>()
        .len() as i64;

    Ok(ImportBackupPayload {
        capture_count: bundle.captures.len() as i64,
        day_count,
        restored_at: Local::now().to_rfc3339(),
    })
}

#[tauri::command]
fn get_capture_context_page(
    state: State<SharedState>,
    capture_id: i64,
    page_size: Option<i64>,
) -> Result<CaptureContextPagePayload, String> {
    let safe_page_size = page_size.unwrap_or(240).clamp(24, 1000);

    let (day_key, captured_at) = with_connection(&state, |conn| {
        conn.query_row(
            "SELECT day_key, captured_at FROM captures WHERE id = ?",
            params![capture_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| format!("failed to resolve capture context row: {error}"))
    })?;

    let total_captures = with_connection(&state, |conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM captures WHERE day_key = ?",
            params![day_key],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("failed to count day captures for context page: {error}"))
    })?;

    let position_in_day = with_connection(&state, |conn| {
        conn.query_row(
            "
            SELECT COUNT(*)
            FROM captures
            WHERE day_key = ?
              AND (captured_at < ? OR (captured_at = ? AND id <= ?))
            ",
            params![day_key, captured_at, captured_at, capture_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("failed to locate capture position in day: {error}"))
    })?;

    let focused_index = (position_in_day - 1).max(0);
    let offset = (focused_index - safe_page_size / 2).max(0);
    let captures = load_day_captures_page(&state, &day_key, offset, safe_page_size)?;

    Ok(CaptureContextPagePayload {
        day_key,
        total_captures,
        offset,
        focused_capture_id: capture_id,
        captures,
    })
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

        let index_snapshot = match conn.query_row(
            "SELECT ocr_text, ocr_status FROM capture_search_index WHERE capture_id = ?",
            params![capture_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok(found) => Some(found),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => {
                return Err(format!(
                    "failed to read capture search index row for note update: {error}"
                ))
            }
        };

        let (ocr_text, ocr_status) =
            index_snapshot.unwrap_or_else(|| (String::new(), "pending".to_string()));

        let (window_title, process_name) = conn
            .query_row(
                "SELECT window_title, process_name FROM captures WHERE id = ?",
                params![capture_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| format!("failed to read capture metadata for note update: {error}"))?;

        let indexed_at = Local::now().to_rfc3339();
        refresh_capture_search_index(
            conn,
            capture_id,
            &note,
            &ocr_text,
            &window_title,
            &process_name,
            &ocr_status,
            None,
            Some(&indexed_at),
        )?;

        Ok(())
    })?;

    bump_indexing_epoch(&state);

    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event: {error}"))?;

    Ok(())
}

#[tauri::command]
fn get_capture_health(state: State<SharedState>) -> CaptureHealthPayload {
    capture_health_payload(&state)
}

#[tauri::command]
fn get_ocr_health() -> OcrHealthPayload {
    ocr_health_payload()
}

#[tauri::command]
fn reindex_all_captures(
    state: State<SharedState>,
    app: AppHandle,
) -> Result<ReindexCapturesPayload, String> {
    if resolve_tesseract_executable().is_none() {
        return Err(
            "local OCR engine unavailable: install Tesseract OCR (or restart MemoryLane after install)"
                .to_string(),
        );
    }

    let capture_ids = with_connection(&state, |conn| {
        let mut stmt = conn
            .prepare("SELECT id FROM captures ORDER BY captured_at ASC")
            .map_err(|error| format!("failed to prepare capture id query for reindex: {error}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("failed to query capture ids for reindex: {error}"))?;

        let mut ids = Vec::<i64>::new();
        for row in rows {
            ids.push(row.map_err(|error| format!("failed to read capture id for reindex: {error}"))?);
        }

        Ok(ids)
    })?;

    with_connection(&state, |conn| {
        conn.execute(
            "
            INSERT INTO capture_search_index (capture_id, ocr_text, search_text, ocr_status)
            SELECT
                captures.id,
                '',
                lower(
                    trim(
                        captures.capture_note || ' ' || captures.window_title || ' ' || captures.process_name
                    )
                ),
                'pending'
            FROM captures
            WHERE NOT EXISTS (
                SELECT 1
                FROM capture_search_index
                WHERE capture_search_index.capture_id = captures.id
            )
            ",
            [],
        )
        .map_err(|error| format!("failed to ensure search rows before reindex: {error}"))?;

        conn.execute(
            "
            UPDATE capture_search_index
            SET ocr_status = 'pending',
                ocr_error = NULL
            WHERE capture_id IN (SELECT id FROM captures)
            ",
            [],
        )
        .map_err(|error| format!("failed to reset OCR status for reindex: {error}"))?;

        Ok(())
    })?;

    bump_indexing_epoch(&state);
    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event after reindex: {error}"))?;

    let queued_count = capture_ids.len() as i64;
    let worker_state = state.inner().clone();
    std::thread::spawn(move || {
        for capture_id in capture_ids {
            let _ = run_capture_index_job(&worker_state, capture_id);
        }
    });

    Ok(ReindexCapturesPayload {
        queued_count,
        queued_at: Local::now().to_rfc3339(),
    })
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
    bump_indexing_epoch(&state);
    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event: {error}"))?;
    Ok(payload)
}

#[tauri::command]
fn delete_capture(state: State<SharedState>, capture_id: i64, app: AppHandle) -> Result<DeleteCapturePayload, String> {
    let payload = delete_capture_internal(&state, capture_id)?;
    bump_indexing_epoch(&state);
    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event: {error}"))?;
    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
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

            let backup_dir = app_data_dir.join("backups");
            fs::create_dir_all(&backup_dir)
                .map_err(|error| format!("failed to ensure backups directory exists: {error}"))?;

            let db_path = app_data_dir.join(DB_FILENAME);

            let conn = Connection::open(&db_path)
                .map_err(|error| format!("failed to open database {}: {error}", db_path.display()))?;
            initialize_database(&conn)?;

            let current_settings = read_settings(&conn)?;

            let state = SharedState {
                db: Arc::new(Mutex::new(conn)),
                capture_dir,
                backup_dir,
                pause_state: Arc::new(AtomicBool::new(current_settings.is_paused)),
                consecutive_capture_failures: Arc::new(AtomicU32::new(0)),
                last_capture_error: Arc::new(Mutex::new(None)),
                allow_exit: Arc::new(AtomicBool::new(false)),
                indexing_epoch: Arc::new(AtomicU64::new(0)),
                search_cache: Arc::new(Mutex::new(HashMap::new())),
                intelligence_cache: Arc::new(Mutex::new(HashMap::new())),
                performance_stats: Arc::new(Mutex::new(PerformanceStats::default())),
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
                        if cfg!(debug_assertions) {
                            return;
                        }

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
            get_fullscreen_state,
            toggle_fullscreen,
            capture_now,
            get_day_summaries,
            get_day_captures,
            search_captures,
            get_day_intelligence,
            get_performance_snapshot,
            export_encrypted_backup,
            import_encrypted_backup,
            get_capture_context_page,
            get_capture_image,
            update_capture_note,
            get_capture_health,
            get_ocr_health,
            reindex_all_captures,
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
    fn build_retrieval_snippet_uses_window_metadata_when_available() {
        let query_parts = parse_retrieval_query_parts("figma");
        let snippet = build_retrieval_snippet(
            "",
            "",
            "Figma - Design System",
            "figma.exe",
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
}
