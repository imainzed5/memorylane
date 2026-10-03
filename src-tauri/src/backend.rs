use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

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
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, State, WindowEvent};
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
const MAX_RULE_ENTRIES: usize = 24;
const MAX_RULE_ENTRY_LEN: usize = 80;
const MAX_TAG_ENTRIES: usize = 16;
const MAX_TAG_ENTRY_LEN: usize = 32;

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
    coordinator: Arc<coordinator::CaptureCoordinator>,
    commands: Arc<coordinator::CommandAdmission>,
    controls: Arc<coordinator::CommandAdmission>,
    backups: Arc<coordinator::CommandAdmission>,
    storage_gate: Arc<Mutex<()>>,
    _archive_lock: Arc<File>,
}

#[derive(Clone)]
struct Settings {
    interval_minutes: i64,
    retention_days: i64,
    storage_cap_gb: f64,
    is_paused: bool,
    startup_on_boot: bool,
    theme_id: String,
    excluded_processes: Vec<String>,
    excluded_window_keywords: Vec<String>,
    pause_processes: Vec<String>,
    pause_window_keywords: Vec<String>,
    sensitive_window_keywords: Vec<String>,
    sensitive_capture_mode: SensitiveCaptureMode,
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
    excluded_processes: Vec<String>,
    excluded_window_keywords: Vec<String>,
    pause_processes: Vec<String>,
    pause_window_keywords: Vec<String>,
    sensitive_window_keywords: Vec<String>,
    sensitive_capture_mode: String,
}

#[derive(Clone, Copy)]
enum SensitiveCaptureMode {
    Skip,
    Redact,
    Pause,
}

impl SensitiveCaptureMode {
    fn from_raw(raw: &str) -> SensitiveCaptureMode {
        match raw.trim().to_ascii_lowercase().as_str() {
            "redact" => SensitiveCaptureMode::Redact,
            "pause" => SensitiveCaptureMode::Pause,
            _ => SensitiveCaptureMode::Skip,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            SensitiveCaptureMode::Skip => "skip",
            SensitiveCaptureMode::Redact => "redact",
            SensitiveCaptureMode::Pause => "pause",
        }
    }
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
    is_bookmarked: bool,
    is_favorite: bool,
    tags: Vec<String>,
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
    is_bookmarked: bool,
    is_favorite: bool,
    tags: Vec<String>,
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
    app_terms: Vec<String>,
    window_terms: Vec<String>,
    tag_terms: Vec<String>,
    require_bookmarked: bool,
    require_favorite: bool,
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
    #[serde(default)]
    excluded_processes: Vec<String>,
    #[serde(default)]
    excluded_window_keywords: Vec<String>,
    #[serde(default)]
    pause_processes: Vec<String>,
    #[serde(default)]
    pause_window_keywords: Vec<String>,
    #[serde(default)]
    sensitive_window_keywords: Vec<String>,
    #[serde(default = "default_sensitive_capture_mode")]
    sensitive_capture_mode: String,
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
    #[serde(default)]
    is_bookmarked: bool,
    #[serde(default)]
    is_favorite: bool,
    #[serde(default)]
    tags: Vec<String>,
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

fn default_sensitive_capture_mode() -> String {
    "skip".to_string()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSuppressedEventPayload {
    mode: String,
    reason: String,
    captured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureReviewPayload {
    capture_id: i64,
    is_bookmarked: bool,
    is_favorite: bool,
    tags: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewShortcutCapturePayload {
    capture_id: i64,
    day_key: String,
    captured_at: String,
    timestamp_label: String,
    tags: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewTagShortcutPayload {
    tag: String,
    capture_count: i64,
    latest_capture_id: i64,
    latest_day_key: String,
    latest_timestamp_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewShortcutsPayload {
    bookmarks: Vec<ReviewShortcutCapturePayload>,
    favorites: Vec<ReviewShortcutCapturePayload>,
    tags: Vec<ReviewTagShortcutPayload>,
}

enum CaptureRunResult {
    Captured,
    CapturedWithPolicy(CaptureSuppressedEventPayload),
    Suppressed(CaptureSuppressedEventPayload),
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
    pending_cleanup_bytes: u64,
    pending_cleanup_count: i64,
    untracked_bytes: u64,
    accounting_ready: bool,
    last_storage_error: Option<String>,
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

fn migrate_legacy_app_data_if_needed(current_app_data: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if let Some(root) = std::env::var_os("APPDATA") {
        return legacy::migrate(current_app_data,&PathBuf::from(root).join("com.memorylane.app"), |_| Ok(()));
    }
    let _ = current_app_data;
    Ok(())
}

fn initialize_database(conn: &Connection) -> Result<(), String> {
    storage::initialize(conn)
}

fn initialize_database_v1(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            interval_minutes INTEGER NOT NULL,
            retention_days INTEGER NOT NULL,
            storage_cap_gb REAL NOT NULL,
            is_paused INTEGER NOT NULL,
            startup_on_boot INTEGER NOT NULL DEFAULT 0,
            theme_id TEXT NOT NULL DEFAULT '',
            excluded_processes TEXT NOT NULL DEFAULT '[]',
            excluded_window_keywords TEXT NOT NULL DEFAULT '[]',
            pause_processes TEXT NOT NULL DEFAULT '[]',
            pause_window_keywords TEXT NOT NULL DEFAULT '[]',
            sensitive_window_keywords TEXT NOT NULL DEFAULT '[]',
            sensitive_capture_mode TEXT NOT NULL DEFAULT 'skip'
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

        CREATE TABLE IF NOT EXISTS capture_annotations (
            capture_id INTEGER PRIMARY KEY,
            is_bookmarked INTEGER NOT NULL DEFAULT 0,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            tags TEXT NOT NULL DEFAULT '[]',
            FOREIGN KEY(capture_id) REFERENCES captures(id)
        );

        CREATE INDEX IF NOT EXISTS idx_captures_day_time ON captures(day_key, captured_at);
        CREATE INDEX IF NOT EXISTS idx_capture_search_status ON capture_search_index(ocr_status);
        CREATE INDEX IF NOT EXISTS idx_capture_annotations_bookmarked ON capture_annotations(is_bookmarked);
        CREATE INDEX IF NOT EXISTS idx_capture_annotations_favorite ON capture_annotations(is_favorite);
        ",
    )
    .map_err(|error| format!("failed to initialize database schema: {error}"))?;

    let existing_settings_count = conn
        .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;

    // Support existing databases created before the startup_on_boot column existed.
    storage::add_column(conn, "settings", "startup_on_boot INTEGER NOT NULL DEFAULT 0")?;

    // Support existing databases created before theme persistence was introduced.
    storage::add_column(conn, "settings", "theme_id TEXT NOT NULL DEFAULT ''")?;
    storage::add_column(conn, "settings", "excluded_processes TEXT NOT NULL DEFAULT '[]'")?;
    storage::add_column(conn, "settings", "excluded_window_keywords TEXT NOT NULL DEFAULT '[]'")?;
    storage::add_column(conn, "settings", "pause_processes TEXT NOT NULL DEFAULT '[]'")?;
    storage::add_column(conn, "settings", "pause_window_keywords TEXT NOT NULL DEFAULT '[]'")?;
    storage::add_column(conn, "settings", "sensitive_window_keywords TEXT NOT NULL DEFAULT '[]'")?;
    storage::add_column(conn, "settings", "sensitive_capture_mode TEXT NOT NULL DEFAULT 'skip'")?;

    // Support existing databases created before capture_note was introduced.
    storage::add_column(conn, "captures", "capture_note TEXT NOT NULL DEFAULT ''")?;

    // Support existing databases created before window/process metadata columns were introduced.
    storage::add_column(conn, "captures", "window_title TEXT NOT NULL DEFAULT ''")?;
    storage::add_column(conn, "captures", "process_name TEXT NOT NULL DEFAULT ''")?;

    // Support existing databases created before capture search indexing was introduced.
    storage::add_column(conn, "capture_search_index", "ocr_text TEXT NOT NULL DEFAULT ''")?;
    storage::add_column(conn, "capture_search_index", "search_text TEXT NOT NULL DEFAULT ''")?;
    storage::add_column(conn, "capture_search_index", "ocr_status TEXT NOT NULL DEFAULT 'pending'")?;
    storage::add_column(conn, "capture_search_index", "ocr_error TEXT")?;
    storage::add_column(conn, "capture_search_index", "indexed_at TEXT")?;

    storage::add_column(conn, "capture_annotations", "is_bookmarked INTEGER NOT NULL DEFAULT 0")?;
    storage::add_column(conn, "capture_annotations", "is_favorite INTEGER NOT NULL DEFAULT 0")?;
    storage::add_column(conn, "capture_annotations", "tags TEXT NOT NULL DEFAULT '[]'")?;

    conn.execute(
        "
        INSERT INTO settings (
            id,
            interval_minutes,
            retention_days,
            storage_cap_gb,
            is_paused,
            startup_on_boot,
            theme_id,
            excluded_processes,
            excluded_window_keywords,
            pause_processes,
            pause_window_keywords,
            sensitive_window_keywords,
            sensitive_capture_mode
        )
        VALUES (1, ?, ?, ?, 1, 0, '', '[]', '[]', '[]', '[]', '[]', 'skip')
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

    conn.execute(
        "
        INSERT INTO capture_annotations (capture_id, is_bookmarked, is_favorite, tags)
        SELECT captures.id, 0, 0, '[]'
        FROM captures
        WHERE NOT EXISTS (
            SELECT 1
            FROM capture_annotations
            WHERE capture_annotations.capture_id = captures.id
        )
        ",
        [],
    )
    .map_err(|error| format!("failed to seed capture annotation rows: {error}"))?;

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
            SELECT
                interval_minutes,
                retention_days,
                storage_cap_gb,
                is_paused,
                startup_on_boot,
                theme_id,
                excluded_processes,
                excluded_window_keywords,
                pause_processes,
                pause_window_keywords,
                sensitive_window_keywords,
                sensitive_capture_mode
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
                excluded_processes: parse_string_list_json(
                    &row.get::<_, String>(6)?,
                    MAX_RULE_ENTRIES,
                    MAX_RULE_ENTRY_LEN,
                ),
                excluded_window_keywords: parse_string_list_json(
                    &row.get::<_, String>(7)?,
                    MAX_RULE_ENTRIES,
                    MAX_RULE_ENTRY_LEN,
                ),
                pause_processes: parse_string_list_json(
                    &row.get::<_, String>(8)?,
                    MAX_RULE_ENTRIES,
                    MAX_RULE_ENTRY_LEN,
                ),
                pause_window_keywords: parse_string_list_json(
                    &row.get::<_, String>(9)?,
                    MAX_RULE_ENTRIES,
                    MAX_RULE_ENTRY_LEN,
                ),
                sensitive_window_keywords: parse_string_list_json(
                    &row.get::<_, String>(10)?,
                    MAX_RULE_ENTRIES,
                    MAX_RULE_ENTRY_LEN,
                ),
                sensitive_capture_mode: SensitiveCaptureMode::from_raw(&row.get::<_, String>(11)?),
            })
        })
        .map_err(|error| format!("failed to read settings: {error}"))?;

    Ok(settings)
}

fn write_settings(conn: &Connection, settings: &Settings) -> Result<(), String> {
    conn.execute(
        "
        UPDATE settings
        SET
            interval_minutes = ?,
            retention_days = ?,
            storage_cap_gb = ?,
            is_paused = ?,
            startup_on_boot = ?,
            theme_id = ?,
            excluded_processes = ?,
            excluded_window_keywords = ?,
            pause_processes = ?,
            pause_window_keywords = ?,
            sensitive_window_keywords = ?,
            sensitive_capture_mode = ?
        WHERE id = 1
        ",
        params![
            settings.interval_minutes,
            settings.retention_days,
            settings.storage_cap_gb,
            if settings.is_paused { 1 } else { 0 },
            if settings.startup_on_boot { 1 } else { 0 },
            settings.theme_id,
            encode_string_list_json(
                &settings.excluded_processes,
                MAX_RULE_ENTRIES,
                MAX_RULE_ENTRY_LEN,
            ),
            encode_string_list_json(
                &settings.excluded_window_keywords,
                MAX_RULE_ENTRIES,
                MAX_RULE_ENTRY_LEN,
            ),
            encode_string_list_json(
                &settings.pause_processes,
                MAX_RULE_ENTRIES,
                MAX_RULE_ENTRY_LEN,
            ),
            encode_string_list_json(
                &settings.pause_window_keywords,
                MAX_RULE_ENTRIES,
                MAX_RULE_ENTRY_LEN,
            ),
            encode_string_list_json(
                &settings.sensitive_window_keywords,
                MAX_RULE_ENTRIES,
                MAX_RULE_ENTRY_LEN,
            ),
            settings.sensitive_capture_mode.as_str(),
        ],
    )
    .map_err(|error| format!("failed to write settings: {error}"))?;

    Ok(())
}

fn ensure_capture_annotation_row(conn: &Connection, capture_id: i64) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO capture_annotations (capture_id, is_bookmarked, is_favorite, tags)
        VALUES (?, 0, 0, '[]')
        ON CONFLICT(capture_id) DO NOTHING
        ",
        params![capture_id],
    )
    .map_err(|error| format!("failed to ensure capture annotation row: {error}"))?;

    Ok(())
}

fn read_capture_annotation_state(
    conn: &Connection,
    capture_id: i64,
) -> Result<(bool, bool, Vec<String>), String> {
    ensure_capture_annotation_row(conn, capture_id)?;

    conn.query_row(
        "SELECT is_bookmarked, is_favorite, tags FROM capture_annotations WHERE capture_id = ?",
        params![capture_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)? != 0,
                row.get::<_, i64>(1)? != 0,
                parse_string_list_json(
                    &row.get::<_, String>(2).unwrap_or_else(|_| "[]".to_string()),
                    MAX_TAG_ENTRIES,
                    MAX_TAG_ENTRY_LEN,
                ),
            ))
        },
    )
    .map_err(|error| format!("failed to read capture annotation state: {error}"))
}

fn match_keyword(haystack_lower: &str, keywords: &[String]) -> Option<String> {
    for keyword in keywords {
        let normalized = normalize_list_entry(keyword, MAX_RULE_ENTRY_LEN)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }

        if haystack_lower.contains(normalized.as_str()) {
            return Some(normalized);
        }
    }

    None
}

fn evaluate_capture_policy(
    settings: &Settings,
    window_title: &str,
    process_name: &str,
) -> Option<CaptureSuppressedEventPayload> {
    let window_lower = window_title.to_ascii_lowercase();
    let process_lower = process_name.to_ascii_lowercase();

    if let Some(hit) = match_keyword(&process_lower, &settings.pause_processes) {
        return Some(CaptureSuppressedEventPayload {
            mode: "pause".to_string(),
            reason: format!("Auto-paused by app pause rule: {hit}"),
            captured: false,
        });
    }

    if let Some(hit) = match_keyword(&window_lower, &settings.pause_window_keywords) {
        return Some(CaptureSuppressedEventPayload {
            mode: "pause".to_string(),
            reason: format!("Auto-paused by window pause rule: {hit}"),
            captured: false,
        });
    }

    if let Some(hit) = match_keyword(&process_lower, &settings.excluded_processes) {
        return Some(CaptureSuppressedEventPayload {
            mode: "skip".to_string(),
            reason: format!("Capture skipped by app exclusion: {hit}"),
            captured: false,
        });
    }

    if let Some(hit) = match_keyword(&window_lower, &settings.excluded_window_keywords) {
        return Some(CaptureSuppressedEventPayload {
            mode: "skip".to_string(),
            reason: format!("Capture skipped by window exclusion: {hit}"),
            captured: false,
        });
    }

    let sensitive_hit = match_keyword(&window_lower, &settings.sensitive_window_keywords)
        .or_else(|| match_keyword(&process_lower, &settings.sensitive_window_keywords));

    if let Some(hit) = sensitive_hit {
        let payload = match settings.sensitive_capture_mode {
            SensitiveCaptureMode::Skip => CaptureSuppressedEventPayload {
                mode: "skip".to_string(),
                reason: format!("Sensitive context skipped: {hit}"),
                captured: false,
            },
            SensitiveCaptureMode::Redact => CaptureSuppressedEventPayload {
                mode: "redact".to_string(),
                reason: format!("Sensitive context redacted: {hit}"),
                captured: true,
            },
            SensitiveCaptureMode::Pause => CaptureSuppressedEventPayload {
                mode: "pause".to_string(),
                reason: format!("Sensitive context auto-paused capture: {hit}"),
                captured: false,
            },
        };
        return Some(payload);
    }

    None
}

fn with_connection<T>(state: &SharedState, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let conn = match state.db.lock() {
        Ok(conn) => conn,
        Err(poisoned) => {
            let conn = poisoned.into_inner();
            // A capture panic unwinds its transaction before releasing this guard. If an
            // outstanding transaction remains, roll it back before allowing another request.
            if !conn.is_autocommit() {
                conn.execute_batch("ROLLBACK").map_err(|e| format!("failed to recover database worker: {e}"))?;
            }
            state.db.clear_poison();
            conn
        }
    };
    storage::enable_foreign_keys(&conn)?;
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

fn normalize_list_entry(raw: &str, max_len: usize) -> Option<String> {
    let normalized = collapse_whitespace(raw.trim());
    if normalized.is_empty() {
        return None;
    }

    Some(normalized.chars().take(max_len).collect::<String>())
}

fn normalize_string_list(raw_values: &[String], max_items: usize, max_len: usize) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut values = Vec::<String>::new();

    for value in raw_values {
        if let Some(entry) = normalize_list_entry(value, max_len) {
            let key = entry.to_ascii_lowercase();
            if seen.insert(key) {
                values.push(entry);
            }
        }

        if values.len() >= max_items {
            break;
        }
    }

    values
}

fn parse_string_list_json(raw_json: &str, max_items: usize, max_len: usize) -> Vec<String> {
    let parsed = serde_json::from_str::<Vec<String>>(raw_json).unwrap_or_default();
    normalize_string_list(&parsed, max_items, max_len)
}

fn encode_string_list_json(values: &[String], max_items: usize, max_len: usize) -> String {
    serde_json::to_string(&normalize_string_list(values, max_items, max_len))
        .unwrap_or_else(|_| "[]".to_string())
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

fn normalize_query_word(token: &str) -> String {
    token
        .trim_matches(|c: char| !(c.is_ascii_alphanumeric() || [':', '-', '_', '.'].contains(&c)))
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
        .map(normalize_query_word)
        .filter(|token| token.len() >= 2)
        .collect::<Vec<_>>();

    let stopwords = stopwords();
    let mut terms = Vec::<String>::new();
    let mut words_for_phrase = Vec::<String>::new();
    let mut app_terms = Vec::<String>::new();
    let mut window_terms = Vec::<String>::new();
    let mut tag_terms = Vec::<String>::new();
    let mut require_bookmarked = false;
    let mut require_favorite = false;

    for token in words {
        match token.as_str() {
            "bookmark" | "bookmarked" => {
                require_bookmarked = true;
                continue;
            }
            "favorite" | "favourite" | "favorited" | "favourited" => {
                require_favorite = true;
                continue;
            }
            _ => {}
        }

        if let Some(value) = token.strip_prefix("app:") {
            if let Some(normalized) = normalize_list_entry(value, MAX_RULE_ENTRY_LEN) {
                app_terms.push(normalized.to_ascii_lowercase());
            }
            continue;
        }

        if let Some(value) = token.strip_prefix("window:") {
            if let Some(normalized) = normalize_list_entry(value, MAX_RULE_ENTRY_LEN) {
                window_terms.push(normalized.to_ascii_lowercase());
            }
            continue;
        }

        if let Some(value) = token.strip_prefix("tag:") {
            if let Some(normalized) = normalize_list_entry(value, MAX_TAG_ENTRY_LEN) {
                tag_terms.push(normalized.to_ascii_lowercase());
            }
            continue;
        }

        let normalized = normalize_token(&token);
        if normalized.len() < 2 {
            continue;
        }

        words_for_phrase.push(normalized.clone());
        if !stopwords.contains(normalized.as_str()) {
            terms.push(normalized);
        }
    }

    // Treat plain multi-word queries as an implied phrase so space-containing
    // searches can match contiguous OCR/note text without requiring quotes.
    if words_for_phrase.len() >= 2 {
        phrases.push(words_for_phrase.join(" "));
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

    seen.clear();
    let mut deduped_app_terms = Vec::<String>::new();
    for term in app_terms {
        if seen.insert(term.clone()) {
            deduped_app_terms.push(term);
        }
    }

    seen.clear();
    let mut deduped_window_terms = Vec::<String>::new();
    for term in window_terms {
        if seen.insert(term.clone()) {
            deduped_window_terms.push(term);
        }
    }

    seen.clear();
    let mut deduped_tag_terms = Vec::<String>::new();
    for term in tag_terms {
        if seen.insert(term.clone()) {
            deduped_tag_terms.push(term);
        }
    }

    RetrievalQueryParts {
        phrases: deduped_phrases,
        terms: deduped_terms,
        app_terms: deduped_app_terms,
        window_terms: deduped_window_terms,
        tag_terms: deduped_tag_terms,
        require_bookmarked,
        require_favorite,
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
        excluded_processes: settings.excluded_processes,
        excluded_window_keywords: settings.excluded_window_keywords,
        pause_processes: settings.pause_processes,
        pause_window_keywords: settings.pause_window_keywords,
        sensitive_window_keywords: settings.sensitive_window_keywords,
        sensitive_capture_mode: settings.sensitive_capture_mode.as_str().to_string(),
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

#[cfg(test)]
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

/// Transparent 1x1 GIF so a capture whose files are gone renders as an empty tile.
const MISSING_THUMBNAIL_DATA_URL: &str =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/// One missing or unreadable file must not take down a whole capture list: fall back to a
/// thumbnail encoded in memory from the full image, then to a blank placeholder.
fn load_thumbnail_data_url(thumbnail_path: &str, image_path: &str) -> String {
    if let Ok(url) = load_image_data_url(thumbnail_path) {
        return url;
    }
    image::open(image_path)
        .ok()
        .and_then(|full| {
            let mut bytes = Vec::new();
            JpegEncoder::new_with_quality(&mut bytes, 68)
                .encode_image(&full.thumbnail(360, 202).to_rgb8())
                .ok()?;
            Some(format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)))
        })
        .unwrap_or_else(|| MISSING_THUMBNAIL_DATA_URL.to_string())
}

fn to_timestamp_label(captured_at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(captured_at)
        .map(|dt| dt.with_timezone(&Local).format("%I:%M %p").to_string())
        .unwrap_or_else(|_| captured_at.to_string())
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
    tags: &[String],
    is_bookmarked: bool,
    is_favorite: bool,
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

        for tag in tags {
            let tag_lower = tag.to_ascii_lowercase();
            if tag_lower.contains(probe) {
                return IndexedTextBundle {
                    snippet: format!("Tag: {}", collapse_whitespace(tag)),
                    source: "tag".to_string(),
                    highlight_terms: vec![probe.to_string()],
                };
            }
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

    if !tags.is_empty() {
        return IndexedTextBundle {
            snippet: format!("Tags: {}", tags.join(", ")),
            source: "tag".to_string(),
            highlight_terms: Vec::new(),
        };
    }

    if is_bookmarked || is_favorite {
        let label = match (is_bookmarked, is_favorite) {
            (true, true) => "Bookmarked and favorited capture",
            (true, false) => "Bookmarked capture",
            (false, true) => "Favorited capture",
            _ => fallback_reason,
        };

        return IndexedTextBundle {
            snippet: label.to_string(),
            source: "metadata".to_string(),
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
    // Apply Windows rules even in non-Windows tests (including ADS and device names).
    if relative_path.is_empty() || relative_path.contains(':') {
        return Err("backup contains invalid relative path".to_string());
    }
    let path = PathBuf::from(relative_path.replace('\\', "/"));

    for name in relative_path.replace('\\', "/").split('/') {
        let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
        if name.is_empty() || name == "." || name.ends_with(['.', ' '])
            || name.chars().any(|c| c.is_control() || "<>\"|?*".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("backup contains invalid Windows path".to_string());
        }
    }

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

fn validate_day_key(day_key: &str) -> Result<(), String> {
    let bytes = day_key.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || bytes.iter().enumerate().any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
        || &day_key[..4] == "0000"
        || NaiveDate::parse_from_str(day_key, "%Y-%m-%d").is_err()
    {
        return Err("day key must be a calendar date in YYYY-MM-DD format".to_string());
    }
    Ok(())
}

fn is_filesystem_indirection(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions and all other reparse points, not only symbolic links.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}

// Check every existing component, including missing-file parents, without following links.
// Only strict descendants may be used as stored file/day deletion targets.
fn validate_managed_path(root: &Path, target: &Path) -> Result<(), String> {
    if !root.is_absolute() || !target.is_absolute() {
        return Err("managed capture paths must be absolute".to_string());
    }
    let relative = target.strip_prefix(root)
        .map_err(|_| "capture path is outside managed storage".to_string())?;
    if relative.as_os_str().is_empty() || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err("invalid managed capture path".to_string());
    }
    let root_metadata = fs::symlink_metadata(root).map_err(|e| format!("cannot inspect capture root: {e}"))?;
    if is_filesystem_indirection(&root_metadata) || !root_metadata.is_dir() {
        return Err("capture root must be a regular directory".to_string());
    }
    for ancestor in root.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(ancestor).map_err(|e| format!("cannot inspect capture root parent: {e}"))?;
        if is_filesystem_indirection(&metadata) {
            return Err("capture root parent contains filesystem indirection".to_string());
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| format!("cannot resolve capture root: {e}"))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if component.as_os_str().to_string_lossy().contains(':') {
            return Err("invalid managed capture path".to_string());
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_filesystem_indirection(&metadata) {
                    return Err("capture path contains filesystem indirection".to_string());
                }
                let resolved = fs::canonicalize(&current).map_err(|e| format!("cannot resolve capture path: {e}"))?;
                if !resolved.starts_with(&canonical_root) {
                    return Err("capture path escapes managed storage".to_string());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(format!("cannot inspect capture path: {e}")),
        }
    }
    Ok(())
}

fn validate_managed_tree(root: &Path, target: &Path) -> Result<(), String> {
    validate_managed_path(root, target)?;
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_dir() => {
            for entry in fs::read_dir(target).map_err(|e| format!("cannot inspect capture directory: {e}"))? {
                validate_managed_tree(root, &entry.map_err(|e| e.to_string())?.path())?;
            }
        }
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    Ok(())
}

fn remove_managed_file(root: &Path, target: &Path) -> Result<bool, String> {
    validate_managed_path(root, target)?;
    match fs::remove_file(target) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("failed to remove capture file: {e}")),
    }
}

fn remove_managed_tree(root: &Path, target: &Path) -> Result<(), String> {
    validate_managed_tree(root, target)?;
    if !target.exists() { return Ok(()); }
    // Recheck each entry immediately before removal; never recurse through reparse points.
    for entry in fs::read_dir(target).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        validate_managed_path(root, &path)?;
        if fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_dir() {
            remove_managed_tree(root, &path)?;
        } else {
            remove_managed_file(root, &path)?;
        }
    }
    validate_managed_path(root, target)?;
    fs::remove_dir(target).map_err(|e| format!("failed to remove capture directory: {e}"))
}

fn validate_capture_root_tree(root: &Path) -> Result<(), String> {
    validate_managed_path(root, &root.join("root_validation"))?;
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        validate_managed_tree(root, &entry.map_err(|e| e.to_string())?.path())?;
    }
    Ok(())
}

fn remove_capture_root_tree(root: &Path) -> Result<(), String> {
    validate_capture_root_tree(root)?;
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        validate_managed_path(root, &path)?;
        if fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_dir() {
            remove_managed_tree(root, &path)?;
        } else {
            remove_managed_file(root, &path)?;
        }
    }
    validate_managed_path(root, &root.join("root_validation"))?;
    fs::remove_dir(root).map_err(|e| e.to_string())
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
    let _storage = storage::gate(state);
    validate_day_key(day_key)?;
    // A day-level preflight preserves the accepted refusal of redirected day contents.
    validate_managed_tree(&state.capture_dir, &state.capture_dir.join(day_key))?;
    let (removed_rows, files) = storage::delete_rows(state, Some(day_key), None)?;
    let removed_files = storage::cleanup_selected(state, true, storage::CLEANUP_BATCH, &files)?;
    state.coordinator.request_maintenance(false);
    Ok(DeleteDayPayload { day_key: day_key.to_string(), removed_rows, removed_files })
}

fn delete_capture_internal(state: &SharedState, capture_id: i64) -> Result<DeleteCapturePayload, String> {
    let _storage = storage::gate(state);
    let day_key = with_connection(state, |conn| conn.query_row("SELECT day_key FROM captures WHERE id=?",
        params![capture_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string()))?;
    let (_,files) = storage::delete_rows(state, None, Some(capture_id))?;
    let removed_files = storage::cleanup_selected(state, true, storage::CLEANUP_BATCH, &files)?;
    state.coordinator.request_maintenance(false);
    Ok(DeleteCapturePayload { capture_id, day_key, removed_files })
}

#[cfg(test)]
fn apply_retention_rules(state: &SharedState) -> Result<(), String> {
    let _storage = storage::gate(state);
    storage::retention(state).map(|_| ())
}

fn capture_once(state: &SharedState, ticket: &coordinator::CaptureTicket, app: Option<&AppHandle>) -> Result<CaptureRunResult, String> {
    capture_once_with(state, ticket, app, privacy::snapshot, capture::capture_primary_display)
}

fn capture_once_with(state: &SharedState, ticket: &coordinator::CaptureTicket, app: Option<&AppHandle>,
    mut snapshot: impl FnMut() -> Result<privacy::PrivacySnapshot, String>,
    acquire: impl FnOnce() -> Result<capture::CaptureOutcome, String>) -> Result<CaptureRunResult, String> {
    let suppressed = |reason: &str| Ok(CaptureRunResult::Suppressed(privacy::suppressed(reason)));
    if !state.coordinator.lock().ticket_valid(ticket) { return suppressed("Recording or privacy settings changed."); }
    let settings = &ticket.settings;
    let before = snapshot()?;
    let policy_outcome = privacy::evaluate(settings, &before);
    if let Some(policy) = &policy_outcome {
        if policy.mode == "pause" { set_pause_internal(state, true, app)?; }
        if policy.mode == "skip" || policy.mode == "pause" {
            clear_capture_error_state(state);
            return Ok(CaptureRunResult::Suppressed(policy.clone()));
        }
    }
    let redact_capture = policy_outcome.as_ref().is_some_and(|policy| policy.mode == "redact");
    let screenshot = match acquire()? {
        capture::CaptureOutcome::Frame(frame) => frame,
        capture::CaptureOutcome::Blank => return suppressed("Screen was blank."),
    };
    if !state.coordinator.lock().ticket_valid(ticket) { return suppressed("Recording or privacy settings changed during capture."); }
    if privacy::context_changed(settings, &before, &snapshot()?) { return suppressed("Desktop context changed during capture."); }
    let now = Local::now();
    let day_key = now.format("%Y-%m-%d").to_string();
    let foreground = before.windows.iter().find(|window| window.handle == before.foreground);
    let window_title = if redact_capture { "[redacted]".to_string() } else { foreground.map(|w| w.title.clone()).unwrap_or_default() };
    let process_name = if redact_capture { "[redacted]".to_string() } else { foreground.map(|w| w.process.clone()).unwrap_or_default() };
    let capture_note = if redact_capture { "[redacted by sensitive capture policy]" } else { "" }.to_string();
    let full_image = if redact_capture {
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(screenshot.width(), screenshot.height(), image::Rgba([8,8,8,255])))
    } else { image::DynamicImage::ImageRgba8(screenshot.clone()) };
    // Encoding is cancellable by generation, and does not touch disk or hold the DB/barrier.
    let mut image_bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut image_bytes, 82).encode_image(&full_image)
        .map_err(|e| format!("failed to encode screenshot: {e}"))?;
    let mut thumbnail_bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut thumbnail_bytes, 68).encode_image(&full_image.thumbnail(360,202))
        .map_err(|e| format!("failed to encode thumbnail: {e}"))?;
    if privacy::context_changed(settings, &before, &snapshot()?) { return suppressed("Desktop context changed while encoding."); }
    let capture_id;
    let mut pending = storage::PendingCaptureFiles::new(state);
    {
        // Pause acknowledgement and persistence are serialized here. Pause can finish while
        // acquisition/encoding is running; an older ticket can never cross this barrier afterward.
        let _storage = storage::gate(state);
        let core = state.coordinator.lock();
        if !core.ticket_valid(ticket) { return suppressed("Recording or privacy settings changed."); }
        if privacy::context_changed(settings, &before, &snapshot()?) { return suppressed("Desktop context changed before saving."); }
        let day_dir = state.capture_dir.join(&day_key);
        validate_managed_path(&state.capture_dir, &day_dir)?;
        fs::create_dir_all(&day_dir).map_err(|e| e.to_string())?;
        validate_managed_path(&state.capture_dir, &day_dir)?;
        let mut nonce = [0u8;16]; OsRng.fill_bytes(&mut nonce);
        let unique = nonce.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let stem = format!("{}_{}", now.format("%Y%m%d_%H%M%S"), unique);
        let image_path = day_dir.join(format!("{stem}.jpg"));
        let thumbnail_path = day_dir.join(format!("{stem}_thumb.jpg"));
        pending.write(&image_path, &image_bytes)?;
        pending.write(&thumbnail_path, &thumbnail_bytes)?;
        if privacy::context_changed(settings, &before, &snapshot()?) { return suppressed("Desktop context changed before saving metadata."); }
        capture_id = with_connection(state, |conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        transaction.execute(
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
                &capture_note,
                &window_title,
                &process_name,
                screenshot.width() as i64,
                screenshot.height() as i64
            ],
        )
        .map_err(|error| format!("failed to persist capture metadata: {error}"))?;

        let inserted_capture_id = transaction.last_insert_rowid();
        ensure_capture_annotation_row(&transaction, inserted_capture_id)?;
        refresh_capture_search_index(
            &transaction,
            inserted_capture_id,
            &capture_note,
            "",
            &window_title,
            &process_name,
            if redact_capture { "redacted" } else { "pending" },
            None,
            None,
        )?;

            pending.commit_files(&transaction)?;
            transaction.commit().map_err(|e| format!("failed to commit capture: {e}"))?;
            Ok(inserted_capture_id)
        })?;
        pending.committed = true;
    }
    bump_indexing_epoch(state);
    if !redact_capture { schedule_capture_index(state.clone(), capture_id); }
    state.coordinator.request_maintenance(false);
    clear_capture_error_state(state);
    if let Some(payload) = policy_outcome { Ok(CaptureRunResult::CapturedWithPolicy(payload)) }
    else { Ok(CaptureRunResult::Captured) }
}


fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn publish_recording_state(app: &AppHandle, state: &SharedState) {
    let payload = state.coordinator.snapshot();
    let _ = app.emit("pause-state-changed", PauseStatePayload { is_paused: payload.is_paused });
    let _ = app.emit("recording-state-changed", payload);
}

fn apply_recording_settings_locked(state: &SharedState, core: &mut coordinator::Core, settings: Settings) {
    state.pause_state.store(settings.is_paused, Ordering::Release);
    core.apply_settings(settings, Instant::now());
    state.coordinator.cache_snapshot(core);
    state.coordinator.notify();
}

// Capture-side exclusion is needed when restore runs off the event thread. Full backup/OCR
// maintenance coordination and recoverable directory swapping remain separate storage work.
struct RestoreCaptureGuard<'a> { state: &'a SharedState, app: &'a AppHandle }
impl<'a> RestoreCaptureGuard<'a> {
    fn begin(state: &'a SharedState, app: &'a AppHandle) -> Result<Self, String> {
        state.coordinator.begin_restore()?;
        publish_recording_state(app, state);
        Ok(Self { state, app })
    }
}
impl Drop for RestoreCaptureGuard<'_> {
    fn drop(&mut self) {
        {
            let mut core = self.state.coordinator.lock();
            core.end_restore();
            self.state.coordinator.cache_snapshot(&core);
        }
        self.state.coordinator.notify();
        publish_recording_state(self.app, self.state);
    }
}

fn set_pause_internal(state: &SharedState, is_paused: bool, app: Option<&AppHandle>) -> Result<(), String> {
    change_pause_internal(state, Some(is_paused), app)
}

fn change_pause_internal(state: &SharedState, requested: Option<bool>, app: Option<&AppHandle>) -> Result<(), String> {
    {
        let mut core = state.coordinator.lock();
        let settings = with_connection(state, |conn| {
            let mut settings = read_settings(conn)?;
            settings.is_paused = requested.unwrap_or(!settings.is_paused);
            write_settings(conn, &settings)?;
            Ok(settings)
        })?;
        apply_recording_settings_locked(state, &mut core, settings);
    }
    if let Some(app) = app { publish_recording_state(app, state); }
    Ok(())
}

fn report_capture_result(app: &AppHandle, state: &SharedState, result: Result<CaptureRunResult, String>) -> Result<(), String> {
    match result {
        Ok(CaptureRunResult::Captured) => { let _ = app.emit("captures-updated", ()); Ok(()) }
        Ok(CaptureRunResult::CapturedWithPolicy(payload)) => {
            let _ = app.emit("captures-updated", ()); let _ = app.emit("capture-suppressed", payload); Ok(())
        }
        Ok(CaptureRunResult::Suppressed(payload)) => {
            clear_capture_error_state(state);
            let reason = payload.reason.clone(); let _ = app.emit("capture-suppressed", payload); Err(reason)
        }
        Err(error) => { let _ = app.emit("capture-error", record_capture_error(state, error.clone())); Err(error) }
    }
}

fn start_capture_worker(app: AppHandle, state: SharedState) -> Result<(), String> {
    let coordinator = state.coordinator.clone();
    let worker = std::thread::Builder::new().name("memorylane-capture".into()).spawn(move || {
        let mut tracker = None;
        while let Some(work) = state.coordinator.wait_next_with_idle(|paused| {
            // Park without SQLite reads, timers, or window-event tracking while paused.
            if paused { tracker = None; }
        }) {
            publish_recording_state(&app, &state);
            if work.ticket.intent == coordinator::CaptureIntent::Maintenance {
                let reconcile = state.coordinator.take_reconciliation();
                let invalidated = storage::run_maintenance(&state, reconcile);
                let _ = app.emit("captures-updated", serde_json::json!({ "contentInvalidated": invalidated }));
                { let mut core = state.coordinator.lock(); core.finish(&work.ticket, Instant::now()); state.coordinator.cache_snapshot(&core); }
                state.coordinator.notify();
                publish_recording_state(&app, &state);
                continue;
            }
            if tracker.is_none() { tracker = privacy::Tracker::start().ok(); }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
                capture_once(&state, &work.ticket, Some(&app))))
                .unwrap_or_else(|_| Err("Capture worker recovered from a panic.".to_string()));
            {
                let mut core = state.coordinator.lock();
                core.finish(&work.ticket, Instant::now());
                state.coordinator.cache_snapshot(&core);
            }
            state.coordinator.notify();
            let reply = report_capture_result(&app, &state, result);
            if let Some(sender) = work.reply { let _ = sender.try_send(reply); }
            publish_recording_state(&app, &state);
        }
    }).map_err(|e| format!("Cannot start capture worker: {e}"))?;
    coordinator.attach_worker(worker);
    Ok(())
}

const TRAY_ID: &str = "memorylane-tray";

/// Tray glyphs are rendered from assets/brand/tray*.svg; see assets/brand/README.md.
fn tray_image(is_paused: bool) -> Result<tauri::image::Image<'static>, String> {
    let bytes: &[u8] = if is_paused {
        include_bytes!("../icons/tray-paused.png")
    } else {
        include_bytes!("../icons/tray.png")
    };
    let rgba = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|error| format!("failed to decode tray icon png: {error}"))?
        .to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(tauri::image::Image::new_owned(rgba.into_raw(), width, height))
}

fn tray_tooltip(is_paused: bool) -> &'static str {
    if is_paused {
        "MemoryLane - Paused"
    } else {
        "MemoryLane - Recording"
    }
}

fn sync_tray_pause_state(app: &AppHandle, is_paused: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(icon) = tray_image(is_paused) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(tray_tooltip(is_paused)));
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let is_paused = app.state::<SharedState>().pause_state.load(Ordering::Relaxed);
    let tray_icon = tray_image(is_paused)?;

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

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .menu(&menu)
        .tooltip(tray_tooltip(is_paused))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_dashboard" => {
                show_main_window(app);
            }
            "toggle_pause" => {
                let state = app.state::<SharedState>().inner().clone();
                let app = app.clone();
                let error_app = app.clone();
                let controls = state.controls.clone();
                tauri::async_runtime::spawn(async move {
                    let result = coordinator::run_blocking(&controls, move || {
                        change_pause_internal(&state, None, Some(&app))
                    }).await;
                    if let Err(error) = result {
                        let _ = error_app.emit("capture-error", CaptureErrorEventPayload { message: format!("Recording state could not be changed: {error}") });
                    }
                });
            }
            "open_folder" => {
                let state = app.state::<SharedState>().inner().clone();
                let admission = state.commands.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = coordinator::run_blocking(&admission, move || open_captures_folder_internal(&state)).await;
                });
            }
            "capture_now" => {
                let state = app.state::<SharedState>();
                if let Err(message) = state.coordinator.request_manual() {
                    let _ = app.emit("capture-error", CaptureErrorEventPayload { message });
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

    // Every pause change (UI, tray menu, policy auto-pause) emits this event.
    let listener_app = app.clone();
    app.listen_any("pause-state-changed", move |_| {
        let update_app = listener_app.clone();
        // Tray setters synchronously dispatch to the main thread. Queue the update without
        // waiting here, or main-thread shutdown joining the worker can deadlock publication.
        let _ = listener_app.run_on_main_thread(move || {
            let paused = update_app.state::<SharedState>().pause_state.load(Ordering::Acquire);
            sync_tray_pause_state(&update_app, paused);
        });
    });

    Ok(())
}

#[tauri::command]
fn get_storage_path(state: State<SharedState>) -> String {
    state.capture_dir.to_string_lossy().to_string()
}

#[tauri::command]
async fn open_captures_folder(state: State<'_, SharedState>) -> Result<(), String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { open_captures_folder_internal(&owned) }).await
}

fn open_captures_folder_internal(state: &SharedState) -> Result<(), String> {
    Command::new("explorer")
        .arg(&state.capture_dir)
        .spawn()
        .map_err(|error| format!("failed to open captures folder: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn reveal_capture_in_explorer(state: State<'_, SharedState>, capture_id: i64) -> Result<(), String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { reveal_capture_in_explorer_internal(&owned, capture_id) }).await
}

fn reveal_capture_in_explorer_internal(state: &SharedState, capture_id: i64) -> Result<(), String> {
    let image_path = with_connection(state, |conn| {
        conn.query_row("SELECT image_path FROM captures WHERE id = ?", params![capture_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to load capture image path: {error}"))
    })?;
    let image_path = PathBuf::from(image_path);
    if !image_path.is_file() {
        return Err("The image file for this capture is missing.".to_string());
    }
    // Only ever hand Explorer a file inside the managed archive.
    validate_managed_path(&state.capture_dir, &image_path)?;

    let mut command = Command::new("explorer");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Explorer parses `/select,"path"` itself; std's quoting of the whole arg breaks it.
        command.raw_arg(format!("/select,\"{}\"", image_path.display()));
    }
    #[cfg(not(windows))]
    command.arg(&image_path);
    command
        .spawn()
        .map_err(|error| format!("failed to open Explorer: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn get_settings(state: State<'_, SharedState>) -> Result<SettingsPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_settings_internal(&owned) }).await
}

fn get_settings_internal(state: &SharedState) -> Result<SettingsPayload, String> {
    with_connection(&state, |conn| read_settings(conn).map(settings_to_payload))
}

#[tauri::command]
async fn update_settings(
    state: State<'_, SharedState>,
    app: AppHandle,
    interval_minutes: Option<i64>,
    retention_days: Option<i64>,
    storage_cap_gb: Option<f64>,
    startup_on_boot: Option<bool>,
    theme_id: Option<String>,
    excluded_processes: Option<Vec<String>>,
    excluded_window_keywords: Option<Vec<String>>,
    pause_processes: Option<Vec<String>>,
    pause_window_keywords: Option<Vec<String>>,
    sensitive_window_keywords: Option<Vec<String>>,
    sensitive_capture_mode: Option<String>,
) -> Result<SettingsPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.controls.clone();
    coordinator::run_blocking(&admission, move || { update_settings_internal(&owned, app, interval_minutes, retention_days, storage_cap_gb, startup_on_boot, theme_id, excluded_processes, excluded_window_keywords, pause_processes, pause_window_keywords, sensitive_window_keywords, sensitive_capture_mode) }).await
}

fn update_settings_internal(
    state: &SharedState,
    app: AppHandle,
    interval_minutes: Option<i64>,
    retention_days: Option<i64>,
    storage_cap_gb: Option<f64>,
    startup_on_boot: Option<bool>,
    theme_id: Option<String>,
    excluded_processes: Option<Vec<String>>,
    excluded_window_keywords: Option<Vec<String>>,
    pause_processes: Option<Vec<String>>,
    pause_window_keywords: Option<Vec<String>>,
    sensitive_window_keywords: Option<Vec<String>>,
    sensitive_capture_mode: Option<String>,
) -> Result<SettingsPayload, String> {
    let mut core = state.coordinator.lock();
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

        if let Some(enabled) = startup_on_boot {
            apply_startup_on_boot_setting(&app, enabled)?;
            settings.startup_on_boot = enabled;
        }

        if let Some(theme) = theme_id {
            settings.theme_id = normalize_theme_id(&theme)?;
        }

        if let Some(values) = excluded_processes {
            settings.excluded_processes =
                normalize_string_list(&values, MAX_RULE_ENTRIES, MAX_RULE_ENTRY_LEN);
        }

        if let Some(values) = excluded_window_keywords {
            settings.excluded_window_keywords =
                normalize_string_list(&values, MAX_RULE_ENTRIES, MAX_RULE_ENTRY_LEN);
        }

        if let Some(values) = pause_processes {
            settings.pause_processes =
                normalize_string_list(&values, MAX_RULE_ENTRIES, MAX_RULE_ENTRY_LEN);
        }

        if let Some(values) = pause_window_keywords {
            settings.pause_window_keywords =
                normalize_string_list(&values, MAX_RULE_ENTRIES, MAX_RULE_ENTRY_LEN);
        }

        if let Some(values) = sensitive_window_keywords {
            settings.sensitive_window_keywords =
                normalize_string_list(&values, MAX_RULE_ENTRIES, MAX_RULE_ENTRY_LEN);
        }

        if let Some(mode) = sensitive_capture_mode {
            settings.sensitive_capture_mode = SensitiveCaptureMode::from_raw(&mode);
        }

        write_settings(conn, &settings)?;
        Ok(settings)
    })?;

    apply_recording_settings_locked(&state, &mut core, updated.clone());
    drop(core);
    publish_recording_state(&app, &state);
    state.coordinator.request_maintenance(false);
    Ok(settings_to_payload(updated))
}

#[tauri::command]
async fn set_startup_on_boot(
    state: State<'_, SharedState>,
    app: AppHandle,
    enabled: bool,
) -> Result<SettingsPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.controls.clone();
    coordinator::run_blocking(&admission, move || { set_startup_on_boot_internal(&owned, app, enabled) }).await
}

fn set_startup_on_boot_internal(
    state: &SharedState,
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
async fn set_pause_state(state: State<'_, SharedState>, app: AppHandle, is_paused: bool) -> Result<coordinator::RecordingStatePayload, String> {
    let owned = state.inner().clone();
    let admission = owned.controls.clone();
    coordinator::run_blocking(&admission, move || { set_pause_state_internal(&owned, app, is_paused) }).await
}

fn set_pause_state_internal(state: &SharedState, app: AppHandle, is_paused: bool) -> Result<coordinator::RecordingStatePayload, String> {
    set_pause_internal(&state, is_paused, Some(&app))?;
    Ok(state.coordinator.snapshot())
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

/// Applies the Windows 11 Mica backdrop behind the transparent webview.
/// Returns false on platforms without Mica so the UI can fall back to an opaque background.
#[tauri::command]
fn set_window_material(app: AppHandle, dark: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    #[cfg(target_os = "windows")]
    {
        Ok(window_vibrancy::apply_mica(&window, Some(dark)).is_ok())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, dark);
        Ok(false)
    }
}

#[tauri::command]
fn get_pause_state(state: State<SharedState>) -> PauseStatePayload {
    PauseStatePayload {
        is_paused: state.pause_state.load(Ordering::Relaxed),
    }
}

#[tauri::command]
async fn capture_now(state: State<'_, SharedState>, app: AppHandle) -> Result<(), String> {
    let mut reply = state.coordinator.request_manual()?;
    publish_recording_state(&app, &state);
    reply.recv().await.ok_or_else(|| "Capture worker stopped before completing the request.".to_string())?
}

#[tauri::command]
fn get_recording_state(state: State<'_, SharedState>) -> coordinator::RecordingStatePayload {
    state.coordinator.recording_state()
}

#[tauri::command]
async fn get_day_summaries(state: State<'_, SharedState>) -> Result<Vec<DaySummaryPayload>, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_day_summaries_internal(&owned) }).await
}

fn get_day_summaries_internal(state: &SharedState) -> Result<Vec<DaySummaryPayload>, String> {
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
async fn get_day_captures(
    state: State<'_, SharedState>,
    day_key: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<DayCapturePayload>, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_day_captures_internal(&owned, day_key, offset, limit) }).await
}

fn get_day_captures_internal(
    state: &SharedState,
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
                    COALESCE(capture_annotations.is_bookmarked, 0),
                    COALESCE(capture_annotations.is_favorite, 0),
                    COALESCE(capture_annotations.tags, '[]'),
                    captures.width,
                    captures.height,
                    COALESCE(capture_search_index.ocr_text, '')
                FROM captures
                LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
                LEFT JOIN capture_annotations ON capture_annotations.capture_id = captures.id
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
                    row.get::<_, i64>(8)? != 0,
                    row.get::<_, i64>(9)? != 0,
                    parse_string_list_json(&row.get::<_, String>(10)?, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
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
                is_bookmarked,
                is_favorite,
                tags,
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
                is_bookmarked,
                is_favorite,
                tags,
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
        is_bookmarked,
        is_favorite,
        tags,
        width,
        height,
        ocr_text,
    ) in rows
    {
        let timestamp_label = to_timestamp_label(&captured_at);
        let thumbnail_data_url = load_thumbnail_data_url(&thumbnail_path, &image_path);

        captures.push(DayCapturePayload {
            id,
            day_key: row_day_key,
            captured_at,
            timestamp_label,
            image_path,
            thumbnail_data_url,
            capture_note,
            ocr_text,
            window_title,
            process_name,
            is_bookmarked,
            is_favorite,
            tags,
            width,
            height,
        });
    }

    Ok(captures)
}

#[tauri::command]
async fn get_total_capture_count(state: State<'_, SharedState>) -> Result<i64, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_total_capture_count_internal(&owned) }).await
}

fn get_total_capture_count_internal(state: &SharedState) -> Result<i64, String> {
    with_connection(&state, |conn| {
        conn.query_row("SELECT COUNT(*) FROM captures", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("failed to get total capture count: {error}"))
    })
}

#[tauri::command]
async fn get_all_captures_page(
    state: State<'_, SharedState>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<DayCapturePayload>, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_all_captures_page_internal(&owned, offset, limit) }).await
}

fn get_all_captures_page_internal(
    state: &SharedState,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<DayCapturePayload>, String> {
    let safe_offset = offset.unwrap_or(0).max(0);
    let safe_limit = limit.unwrap_or(60).clamp(1, 1000);

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
                    COALESCE(capture_annotations.is_bookmarked, 0),
                    COALESCE(capture_annotations.is_favorite, 0),
                    COALESCE(capture_annotations.tags, '[]'),
                    captures.width,
                    captures.height,
                    COALESCE(capture_search_index.ocr_text, '')
                FROM captures
                LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
                LEFT JOIN capture_annotations ON capture_annotations.capture_id = captures.id
                ORDER BY captures.captured_at DESC
                LIMIT ? OFFSET ?
                ",
            )
            .map_err(|error| format!("failed to prepare all captures query: {error}"))?;

        let rows = stmt
            .query_map(params![safe_limit, safe_offset], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)? != 0,
                    row.get::<_, i64>(9)? != 0,
                    parse_string_list_json(&row.get::<_, String>(10)?, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                ))
            })
            .map_err(|error| format!("failed to run all captures query: {error}"))?;

        let mut capture_rows = Vec::new();

        for row in rows {
            capture_rows.push(row.map_err(|error| format!("failed to read capture row: {error}"))?);
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
        is_bookmarked,
        is_favorite,
        tags,
        width,
        height,
        ocr_text,
    ) in rows
    {
        let timestamp_label = to_timestamp_label(&captured_at);
        let thumbnail_data_url = load_thumbnail_data_url(&thumbnail_path, &image_path);

        captures.push(DayCapturePayload {
            id,
            day_key: row_day_key,
            captured_at,
            timestamp_label,
            image_path,
            thumbnail_data_url,
            capture_note,
            ocr_text,
            window_title,
            process_name,
            is_bookmarked,
            is_favorite,
            tags,
            width,
            height,
        });
    }

    Ok(captures)
}

#[tauri::command]
async fn search_captures(
    state: State<'_, SharedState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<RetrievalSearchResultPayload>, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { search_captures_internal(&owned, query, limit) }).await
}

fn search_captures_internal(
    state: &SharedState,
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
    let has_structured_filters = !query_parts.app_terms.is_empty()
        || !query_parts.window_terms.is_empty()
        || !query_parts.tag_terms.is_empty()
        || query_parts.require_bookmarked
        || query_parts.require_favorite;

    if !has_text_query
        && !has_structured_filters
        && time_hint.target_minutes.is_none()
        && time_hint.day_key.is_none()
    {
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
                COALESCE(capture_search_index.ocr_text, ''),
                COALESCE(capture_annotations.is_bookmarked, 0),
                COALESCE(capture_annotations.is_favorite, 0),
                COALESCE(capture_annotations.tags, '[]')
            FROM captures
            LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
            LEFT JOIN capture_annotations ON capture_annotations.capture_id = captures.id
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
                COALESCE(capture_search_index.ocr_text, ''),
                COALESCE(capture_annotations.is_bookmarked, 0),
                COALESCE(capture_annotations.is_favorite, 0),
                COALESCE(capture_annotations.tags, '[]')
            FROM captures
            LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
            LEFT JOIN capture_annotations ON capture_annotations.capture_id = captures.id
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
                        row.get::<_, i64>(7)? != 0,
                        row.get::<_, i64>(8)? != 0,
                        parse_string_list_json(&row.get::<_, String>(9)?, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
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
                        row.get::<_, i64>(7)? != 0,
                        row.get::<_, i64>(8)? != 0,
                        parse_string_list_json(&row.get::<_, String>(9)?, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
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

    for (
        capture_id,
        day_key,
        captured_at,
        capture_note,
        window_title,
        process_name,
        ocr_text,
        is_bookmarked,
        is_favorite,
        tags,
    ) in rows
    {
        let note_lower = capture_note.to_ascii_lowercase();
        let ocr_lower = ocr_text.to_ascii_lowercase();
        let window_lower = window_title.to_ascii_lowercase();
        let process_lower = process_name.to_ascii_lowercase();
        let tags_lower = tags
            .iter()
            .map(|tag| tag.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let tags_blob = tags_lower.join(" ");
        let mut score = 0.0;
        let mut reasons = Vec::<String>::new();
        let mut highlight_terms = HashSet::<String>::new();

        if query_parts.require_bookmarked && !is_bookmarked {
            continue;
        }

        if query_parts.require_favorite && !is_favorite {
            continue;
        }

        let app_filter_hits = query_parts
            .app_terms
            .iter()
            .filter(|term| process_lower.contains(term.as_str()) || window_lower.contains(term.as_str()))
            .count() as i64;
        let window_filter_hits = query_parts
            .window_terms
            .iter()
            .filter(|term| window_lower.contains(term.as_str()))
            .count() as i64;
        let tag_filter_hits = query_parts
            .tag_terms
            .iter()
            .filter(|term| tags_blob.contains(term.as_str()))
            .count() as i64;

        if !query_parts.app_terms.is_empty() && app_filter_hits == 0 {
            continue;
        }

        if !query_parts.window_terms.is_empty() && window_filter_hits == 0 {
            continue;
        }

        if !query_parts.tag_terms.is_empty() && tag_filter_hits == 0 {
            continue;
        }

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
            if total_text_hits == 0 && time_hint.target_minutes.is_none() && !has_structured_filters {
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

        if app_filter_hits > 0 {
            score += (app_filter_hits as f64) * 2.4;
            reasons.push("app".to_string());
            for term in &query_parts.app_terms {
                if process_lower.contains(term) || window_lower.contains(term) {
                    highlight_terms.insert(term.clone());
                }
            }
        }

        if window_filter_hits > 0 {
            score += (window_filter_hits as f64) * 2.2;
            reasons.push("window".to_string());
            for term in &query_parts.window_terms {
                if window_lower.contains(term) {
                    highlight_terms.insert(term.clone());
                }
            }
        }

        if tag_filter_hits > 0 {
            score += (tag_filter_hits as f64) * 2.7;
            reasons.push("tag".to_string());
            for term in &query_parts.tag_terms {
                if tags_blob.contains(term) {
                    highlight_terms.insert(term.clone());
                }
            }
        }

        if query_parts.require_bookmarked {
            score += 1.2;
            reasons.push("bookmark".to_string());
        }

        if query_parts.require_favorite {
            score += 1.2;
            reasons.push("favorite".to_string());
        }

        if is_bookmarked {
            score += 0.22;
        }

        if is_favorite {
            score += 0.22;
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
            &tags,
            is_bookmarked,
            is_favorite,
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
            is_bookmarked,
            is_favorite,
            tags,
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
async fn get_day_intelligence(
    state: State<'_, SharedState>,
    day_key: String,
) -> Result<DayIntelligencePayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_day_intelligence_internal(&owned, day_key) }).await
}

fn get_day_intelligence_internal(
    state: &SharedState,
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
async fn export_encrypted_backup(state: State<'_, SharedState>, passphrase: String) -> Result<String, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    let backup_permit = owned.backups.enter()?;
    coordinator::run_blocking(&admission, move || { let _backup_permit = backup_permit; export_encrypted_backup_internal(&owned, passphrase) }).await
}

fn export_encrypted_backup_internal(state: &SharedState, passphrase: String) -> Result<String, String> {
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
                    capture_search_index.indexed_at,
                    COALESCE(capture_annotations.is_bookmarked, 0),
                    COALESCE(capture_annotations.is_favorite, 0),
                    COALESCE(capture_annotations.tags, '[]')
                FROM captures
                LEFT JOIN capture_search_index ON capture_search_index.capture_id = captures.id
                LEFT JOIN capture_annotations ON capture_annotations.capture_id = captures.id
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
                    row.get::<_, i64>(15)? != 0,
                    row.get::<_, i64>(16)? != 0,
                    parse_string_list_json(&row.get::<_, String>(17)?, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
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
                is_bookmarked,
                is_favorite,
                tags,
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
                    is_bookmarked,
                    is_favorite,
                    tags,
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
            excluded_processes: settings.excluded_processes,
            excluded_window_keywords: settings.excluded_window_keywords,
            pause_processes: settings.pause_processes,
            pause_window_keywords: settings.pause_window_keywords,
            sensitive_window_keywords: settings.sensitive_window_keywords,
            sensitive_capture_mode: settings.sensitive_capture_mode.as_str().to_string(),
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
async fn import_encrypted_backup(
    state: State<'_, SharedState>,
    app: AppHandle,
    backup_path: String,
    passphrase: String,
) -> Result<ImportBackupPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    let backup_permit = owned.backups.enter()?;
    coordinator::run_blocking(&admission, move || { let _backup_permit = backup_permit; import_encrypted_backup_internal(&owned, app, backup_path, passphrase) }).await
}

fn import_encrypted_backup_internal(
    state: &SharedState,
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

    // Reject all imported keys and paths before staging or modifying live files/rows.
    for capture in &bundle.captures {
        validate_day_key(&capture.day_key)?;
        normalize_backup_relative_path(&capture.relative_image_path)?;
        normalize_backup_relative_path(&capture.relative_thumbnail_path)?;
    }
    validate_capture_root_tree(&state.capture_dir)?;

    let restore_staging_dir = state
        .capture_dir
        .parent()
        .unwrap_or(&state.capture_dir)
        .join(format!("captures_restore_staging_{}", Local::now().timestamp_nanos_opt().unwrap_or_default()));

    // A collision is an error; never recursively delete a preexisting staging path.
    fs::create_dir(&restore_staging_dir)
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
        validate_managed_path(&restore_staging_dir, &image_path)?;
        validate_managed_path(&restore_staging_dir, &thumbnail_path)?;

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

    let _capture_guard = RestoreCaptureGuard::begin(state, &app)?;
    let _storage = storage::gate(state);
    storage::validate_restore_cleanup(state)?;
    let mut core = state.coordinator.lock();
    let restored_settings = with_connection(&state, |conn| {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| format!("failed to open backup restore transaction: {error}"))?;
        let restored_theme_id = normalize_theme_id(&bundle.settings.theme_id)?;
        let restored_sensitive_mode = SensitiveCaptureMode::from_raw(&bundle.settings.sensitive_capture_mode);
        let restored_excluded_processes =
            normalize_string_list(&bundle.settings.excluded_processes, MAX_RULE_ENTRIES, MAX_RULE_ENTRY_LEN);
        let restored_excluded_window_keywords = normalize_string_list(
            &bundle.settings.excluded_window_keywords,
            MAX_RULE_ENTRIES,
            MAX_RULE_ENTRY_LEN,
        );
        let restored_pause_processes =
            normalize_string_list(&bundle.settings.pause_processes, MAX_RULE_ENTRIES, MAX_RULE_ENTRY_LEN);
        let restored_pause_window_keywords = normalize_string_list(
            &bundle.settings.pause_window_keywords,
            MAX_RULE_ENTRIES,
            MAX_RULE_ENTRY_LEN,
        );
        let restored_sensitive_keywords = normalize_string_list(
            &bundle.settings.sensitive_window_keywords,
            MAX_RULE_ENTRIES,
            MAX_RULE_ENTRY_LEN,
        );

        transaction
            .execute("DELETE FROM capture_search_index", [])
            .map_err(|error| format!("failed clearing search index rows during restore: {error}"))?;
        transaction
            .execute("DELETE FROM capture_annotations", [])
            .map_err(|error| format!("failed clearing capture annotation rows during restore: {error}"))?;
        transaction
            .execute("DELETE FROM captures", [])
            .map_err(|error| format!("failed clearing capture rows during restore: {error}"))?;
        transaction
            .execute("DELETE FROM settings", [])
            .map_err(|error| format!("failed clearing settings row during restore: {error}"))?;

        transaction
            .execute(
                "
                INSERT INTO settings (
                    id,
                    interval_minutes,
                    retention_days,
                    storage_cap_gb,
                    is_paused,
                    startup_on_boot,
                    theme_id,
                    excluded_processes,
                    excluded_window_keywords,
                    pause_processes,
                    pause_window_keywords,
                    sensitive_window_keywords,
                    sensitive_capture_mode
                )
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ",
                params![
                    bundle.settings.interval_minutes,
                    bundle.settings.retention_days,
                    bundle.settings.storage_cap_gb,
                    if bundle.settings.is_paused { 1 } else { 0 },
                    if bundle.settings.startup_on_boot { 1 } else { 0 },
                    restored_theme_id,
                    encode_string_list_json(
                        &restored_excluded_processes,
                        MAX_RULE_ENTRIES,
                        MAX_RULE_ENTRY_LEN,
                    ),
                    encode_string_list_json(
                        &restored_excluded_window_keywords,
                        MAX_RULE_ENTRIES,
                        MAX_RULE_ENTRY_LEN,
                    ),
                    encode_string_list_json(
                        &restored_pause_processes,
                        MAX_RULE_ENTRIES,
                        MAX_RULE_ENTRY_LEN,
                    ),
                    encode_string_list_json(
                        &restored_pause_window_keywords,
                        MAX_RULE_ENTRIES,
                        MAX_RULE_ENTRY_LEN,
                    ),
                    encode_string_list_json(
                        &restored_sensitive_keywords,
                        MAX_RULE_ENTRIES,
                        MAX_RULE_ENTRY_LEN,
                    ),
                    restored_sensitive_mode.as_str(),
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

            transaction
                .execute(
                    "
                    INSERT INTO capture_annotations (capture_id, is_bookmarked, is_favorite, tags)
                    VALUES (?, ?, ?, ?)
                    ",
                    params![
                        capture.id,
                        if capture.is_bookmarked { 1 } else { 0 },
                        if capture.is_favorite { 1 } else { 0 },
                        encode_string_list_json(&capture.tags, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
                    ],
                )
                .map_err(|error| format!("failed restoring capture annotation row: {error}"))?;
        }

        transaction.execute("UPDATE storage_accounting SET reconciled=0 WHERE id=1", []).map_err(|e| e.to_string())?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit backup restore transaction: {error}"))?;

        read_settings(conn)
    })?;
    // Synchronize and invalidate active tickets at the settings commit boundary, even
    // if the later directory swap fails (recoverable swaps are handled in unit 5).
    apply_recording_settings_locked(&state, &mut core, restored_settings);
    drop(core);
    publish_recording_state(&app, &state);

    if state.capture_dir.exists() {
        remove_capture_root_tree(&state.capture_dir)?;
    }
    fs::rename(&restore_staging_dir, &state.capture_dir)
        .map_err(|error| format!("failed finalizing restored capture directory: {error}"))?;

    storage::after_import(state)?;
    bump_indexing_epoch(&state);
    app.emit("captures-updated", serde_json::json!({ "contentInvalidated": true }))
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
async fn get_capture_context_page(
    state: State<'_, SharedState>,
    capture_id: i64,
    page_size: Option<i64>,
) -> Result<CaptureContextPagePayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_capture_context_page_internal(&owned, capture_id, page_size) }).await
}

fn get_capture_context_page_internal(
    state: &SharedState,
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
async fn get_capture_image(state: State<'_, SharedState>, capture_id: i64) -> Result<CaptureImagePayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_capture_image_internal(&owned, capture_id) }).await
}

fn get_capture_image_internal(state: &SharedState, capture_id: i64) -> Result<CaptureImagePayload, String> {
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
async fn update_capture_note(
    state: State<'_, SharedState>,
    app: AppHandle,
    capture_id: i64,
    note: String,
) -> Result<(), String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { update_capture_note_internal(&owned, app, capture_id, note) }).await
}

fn update_capture_note_internal(
    state: &SharedState,
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

fn redact_image_file(path: &str) -> Result<(), String> {
    let source = image::open(path).map_err(|error| format!("failed to load image for redaction: {error}"))?;
    let width = source.width();
    let height = source.height();
    let redacted = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([8, 8, 8, 255]),
    ));

    if path.to_ascii_lowercase().ends_with(".jpg") || path.to_ascii_lowercase().ends_with(".jpeg") {
        let file = File::create(path).map_err(|error| format!("failed to rewrite redacted image: {error}"))?;
        let writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(writer, 82);
        encoder
            .encode_image(&redacted)
            .map_err(|error| format!("failed to encode redacted jpeg: {error}"))?;
    } else {
        redacted
            .save(path)
            .map_err(|error| format!("failed to save redacted image: {error}"))?;
    }

    Ok(())
}

fn load_review_shortcuts_internal(state: &SharedState, limit: i64) -> Result<ReviewShortcutsPayload, String> {
    let safe_limit = limit.clamp(1, 64);

    with_connection(state, |conn| {
        let load_flagged = |flag_column: &str| -> Result<Vec<ReviewShortcutCapturePayload>, String> {
            let sql = format!(
                "
                SELECT
                    captures.id,
                    captures.day_key,
                    captures.captured_at,
                    COALESCE(capture_annotations.tags, '[]')
                FROM captures
                INNER JOIN capture_annotations ON capture_annotations.capture_id = captures.id
                WHERE capture_annotations.{flag_column} = 1
                ORDER BY captures.captured_at DESC
                LIMIT ?
                "
            );

            let mut stmt = conn
                .prepare(&sql)
                .map_err(|error| format!("failed to prepare review shortcut query: {error}"))?;

            let rows = stmt
                .query_map(params![safe_limit], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        parse_string_list_json(&row.get::<_, String>(3)?, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
                    ))
                })
                .map_err(|error| format!("failed to execute review shortcut query: {error}"))?;

            let mut payload = Vec::<ReviewShortcutCapturePayload>::new();
            for row in rows {
                let (capture_id, day_key, captured_at, tags) =
                    row.map_err(|error| format!("failed to read review shortcut row: {error}"))?;
                payload.push(ReviewShortcutCapturePayload {
                    capture_id,
                    day_key,
                    timestamp_label: to_timestamp_label(&captured_at),
                    captured_at,
                    tags,
                });
            }

            Ok(payload)
        };

        let bookmarks = load_flagged("is_bookmarked")?;
        let favorites = load_flagged("is_favorite")?;

        let mut tag_frequency = HashMap::<String, (i64, i64, String, String)>::new();
        let mut stmt = conn
            .prepare(
                "
                SELECT
                    captures.id,
                    captures.day_key,
                    captures.captured_at,
                    COALESCE(capture_annotations.tags, '[]')
                FROM captures
                INNER JOIN capture_annotations ON capture_annotations.capture_id = captures.id
                ORDER BY captures.captured_at DESC
                LIMIT 5000
                ",
            )
            .map_err(|error| format!("failed to prepare tag shortcut query: {error}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    parse_string_list_json(&row.get::<_, String>(3)?, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
                ))
            })
            .map_err(|error| format!("failed to execute tag shortcut query: {error}"))?;

        for row in rows {
            let (capture_id, day_key, captured_at, tags) =
                row.map_err(|error| format!("failed to read tag shortcut row: {error}"))?;

            for tag in tags {
                let key = tag.to_ascii_lowercase();
                let entry = tag_frequency
                    .entry(key)
                    .or_insert((0, capture_id, day_key.clone(), captured_at.clone()));
                entry.0 = entry.0.saturating_add(1);
            }
        }

        let mut tags = tag_frequency
            .into_iter()
            .map(|(tag, (count, latest_capture_id, latest_day_key, latest_captured_at))| {
                ReviewTagShortcutPayload {
                    tag,
                    capture_count: count,
                    latest_capture_id,
                    latest_day_key,
                    latest_timestamp_label: to_timestamp_label(&latest_captured_at),
                }
            })
            .collect::<Vec<_>>();

        tags.sort_by(|left, right| {
            right
                .capture_count
                .cmp(&left.capture_count)
                .then_with(|| left.tag.cmp(&right.tag))
        });
        tags.truncate(safe_limit as usize);

        Ok(ReviewShortcutsPayload {
            bookmarks,
            favorites,
            tags,
        })
    })
}

#[tauri::command]
async fn set_capture_review_state(
    state: State<'_, SharedState>,
    app: AppHandle,
    capture_id: i64,
    is_bookmarked: Option<bool>,
    is_favorite: Option<bool>,
    tags: Option<Vec<String>>,
) -> Result<CaptureReviewPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { set_capture_review_state_internal(&owned, app, capture_id, is_bookmarked, is_favorite, tags) }).await
}

fn set_capture_review_state_internal(
    state: &SharedState,
    app: AppHandle,
    capture_id: i64,
    is_bookmarked: Option<bool>,
    is_favorite: Option<bool>,
    tags: Option<Vec<String>>,
) -> Result<CaptureReviewPayload, String> {
    let payload = with_connection(&state, |conn| {
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM captures WHERE id = ?)",
                params![capture_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("failed to validate capture review target: {error}"))?;

        if exists == 0 {
            return Err("capture not found for review update".to_string());
        }

        let (current_bookmarked, current_favorite, current_tags) =
            read_capture_annotation_state(conn, capture_id)?;

        let next_bookmarked = is_bookmarked.unwrap_or(current_bookmarked);
        let next_favorite = is_favorite.unwrap_or(current_favorite);
        let next_tags = tags
            .map(|values| normalize_string_list(&values, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN))
            .unwrap_or(current_tags);

        conn.execute(
            "
            UPDATE capture_annotations
            SET is_bookmarked = ?, is_favorite = ?, tags = ?
            WHERE capture_id = ?
            ",
            params![
                if next_bookmarked { 1 } else { 0 },
                if next_favorite { 1 } else { 0 },
                encode_string_list_json(&next_tags, MAX_TAG_ENTRIES, MAX_TAG_ENTRY_LEN),
                capture_id,
            ],
        )
        .map_err(|error| format!("failed to update capture review state: {error}"))?;

        Ok(CaptureReviewPayload {
            capture_id,
            is_bookmarked: next_bookmarked,
            is_favorite: next_favorite,
            tags: next_tags,
        })
    })?;

    bump_indexing_epoch(&state);
    app.emit("captures-updated", ())
        .map_err(|error| format!("failed to emit capture update event after review update: {error}"))?;

    Ok(payload)
}

#[tauri::command]
async fn get_review_shortcuts(
    state: State<'_, SharedState>,
    limit: Option<i64>,
) -> Result<ReviewShortcutsPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_review_shortcuts_internal(&owned, limit) }).await
}

fn get_review_shortcuts_internal(
    state: &SharedState,
    limit: Option<i64>,
) -> Result<ReviewShortcutsPayload, String> {
    load_review_shortcuts_internal(&state, limit.unwrap_or(12))
}

#[tauri::command]
async fn redact_capture(
    state: State<'_, SharedState>,
    app: AppHandle,
    capture_id: i64,
    redact_image: Option<bool>,
    redact_metadata: Option<bool>,
    clear_note: Option<bool>,
) -> Result<(), String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { redact_capture_internal(&owned, app, capture_id, redact_image, redact_metadata, clear_note) }).await
}

fn redact_capture_internal(
    state: &SharedState,
    app: AppHandle,
    capture_id: i64,
    redact_image: Option<bool>,
    redact_metadata: Option<bool>,
    clear_note: Option<bool>,
) -> Result<(), String> {
    let _storage = storage::gate(state);
    with_connection(state, |conn| {
        storage::touch_content(conn,capture_id)?;
        if redact_image.unwrap_or(true) {
            conn.execute("UPDATE storage_accounting SET reconciled=0 WHERE id=1", []).map_err(|e|e.to_string())?;
        }
        Ok(())
    })?;
    state.coordinator.request_maintenance(redact_image.unwrap_or(true));
    let redact_image = redact_image.unwrap_or(true);
    let redact_metadata = redact_metadata.unwrap_or(true);
    let clear_note = clear_note.unwrap_or(false);

    let (image_path, thumbnail_path, existing_note) = with_connection(&state, |conn| {
        conn.query_row(
            "SELECT image_path, thumbnail_path, capture_note FROM captures WHERE id = ?",
            params![capture_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| format!("failed to resolve capture for redaction: {error}"))
    })?;

    if redact_image {
        validate_managed_path(&state.capture_dir, Path::new(&image_path))?;
        validate_managed_path(&state.capture_dir, Path::new(&thumbnail_path))?;
        redact_image_file(&image_path)?;
        redact_image_file(&thumbnail_path)?;
        with_connection(state, |conn| { storage::record_live(conn,Path::new(&image_path))?;
            storage::record_live(conn,Path::new(&thumbnail_path)) })?;
    }

    with_connection(&state, |conn| {
        let mut note_for_index = if clear_note {
            String::new()
        } else {
            existing_note.clone()
        };

        if redact_metadata {
            let next_note = if clear_note {
                String::new()
            } else if existing_note.trim().is_empty() {
                "[redacted manually]".to_string()
            } else {
                existing_note.clone()
            };
            note_for_index = next_note.clone();

            conn.execute(
                "
                UPDATE captures
                SET capture_note = ?, window_title = '[redacted]', process_name = '[redacted]'
                WHERE id = ?
                ",
                params![next_note, capture_id],
            )
            .map_err(|error| format!("failed to redact capture metadata: {error}"))?;
        } else if clear_note {
            note_for_index = String::new();
            conn.execute(
                "UPDATE captures SET capture_note = '' WHERE id = ?",
                params![capture_id],
            )
            .map_err(|error| format!("failed to clear capture note during redaction: {error}"))?;
        }

        let (window_title, process_name) = conn
            .query_row(
                "SELECT window_title, process_name FROM captures WHERE id = ?",
                params![capture_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| format!("failed to read capture metadata after redaction: {error}"))?;

        let indexed_at = Local::now().to_rfc3339();
        refresh_capture_search_index(
            conn,
            capture_id,
            &note_for_index,
            "",
            &window_title,
            &process_name,
            "redacted",
            None,
            Some(&indexed_at),
        )
    })?;

    bump_indexing_epoch(&state);
    app.emit("captures-updated", serde_json::json!({ "contentInvalidated": true }))
        .map_err(|error| format!("failed to emit capture update event after redaction: {error}"))?;

    Ok(())
}

#[tauri::command]
fn get_capture_health(state: State<SharedState>) -> CaptureHealthPayload {
    capture_health_payload(&state)
}

#[tauri::command]
async fn get_ocr_health(state: State<'_, SharedState>) -> Result<OcrHealthPayload, String> {
    let admission = state.commands.clone();
    coordinator::run_blocking(&admission, || Ok(ocr_health_payload())).await
}

#[tauri::command]
async fn reindex_all_captures(
    state: State<'_, SharedState>,
    app: AppHandle,
) -> Result<ReindexCapturesPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { reindex_all_captures_internal(&owned, app) }).await
}

fn reindex_all_captures_internal(
    state: &SharedState,
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
    let worker_state = state.clone();
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
async fn get_storage_stats(state: State<'_, SharedState>) -> Result<StorageStatsPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { get_storage_stats_internal(&owned) }).await
}

fn get_storage_stats_internal(state: &SharedState) -> Result<StorageStatsPayload, String> {
    with_connection(state, |conn| {
        let (used_bytes,pending_cleanup_bytes,untracked_bytes,capture_count,accounting_ready,last_storage_error) =
            conn.query_row("SELECT used_bytes,pending_bytes,untracked_bytes,capture_count,reconciled,
                coalesce(maintenance_error,last_error,(SELECT last_error FROM managed_files WHERE last_error IS NOT NULL LIMIT 1))
                FROM storage_accounting WHERE id=1",[],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,u64>(1)?,r.get::<_,u64>(2)?,
                    r.get::<_,i64>(3)?,r.get::<_,bool>(4)?,r.get::<_,Option<String>>(5)?))).map_err(|e|e.to_string())?;
        let pending_cleanup_count = conn.query_row("SELECT count(*) FROM managed_files WHERE state IN ('pending','staging')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        let cap_gb = read_settings(conn)?.storage_cap_gb;
        let used_gb = used_bytes as f64/(1024.0*1024.0*1024.0);
        Ok(StorageStatsPayload { used_bytes,used_gb,storage_cap_gb:cap_gb,
            usage_percent:if cap_gb>0.0 {(used_gb/cap_gb*100.0).min(100.0)} else {0.0},capture_count,
            pending_cleanup_bytes,pending_cleanup_count,untracked_bytes,accounting_ready,last_storage_error })
    })
}

#[tauri::command]
async fn delete_day(state: State<'_, SharedState>, day_key: String, app: AppHandle) -> Result<DeleteDayPayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { delete_day_command_internal(&owned, day_key, app) }).await
}

fn delete_day_command_internal(state: &SharedState, day_key: String, app: AppHandle) -> Result<DeleteDayPayload, String> {
    let payload = delete_day_internal(&state, &day_key)?;
    bump_indexing_epoch(&state);
    app.emit("captures-updated", serde_json::json!({ "contentInvalidated": true }))
        .map_err(|error| format!("failed to emit capture update event: {error}"))?;
    Ok(payload)
}

#[tauri::command]
async fn delete_capture(state: State<'_, SharedState>, capture_id: i64, app: AppHandle) -> Result<DeleteCapturePayload, String> {
    let owned = state.inner().clone();
    let admission = owned.commands.clone();
    coordinator::run_blocking(&admission, move || { delete_capture_command_internal(&owned, capture_id, app) }).await
}

fn delete_capture_command_internal(state: &SharedState, capture_id: i64, app: AppHandle) -> Result<DeleteCapturePayload, String> {
    let payload = delete_capture_internal(&state, capture_id)?;
    bump_indexing_epoch(&state);
    app.emit("captures-updated", serde_json::json!({ "contentInvalidated": true }))
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
            let archive_lock = storage::lock_archive(&app_data_dir)?;
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
                coordinator: Arc::new(coordinator::CaptureCoordinator::new(current_settings.clone())),
                commands: Arc::new(coordinator::CommandAdmission::new(8)),
                controls: Arc::new(coordinator::CommandAdmission::new(2)),
                backups: Arc::new(coordinator::CommandAdmission::new(1)),
                storage_gate: Arc::new(Mutex::new(())),
                _archive_lock: archive_lock,
            };

            state.coordinator.request_maintenance(true);
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

            start_capture_worker(app_handle.clone(), state.clone())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_storage_path,
            open_captures_folder,
            reveal_capture_in_explorer,
            get_settings,
            update_settings,
            set_startup_on_boot,
            get_pause_state,
            get_recording_state,
            set_pause_state,
            get_fullscreen_state,
            toggle_fullscreen,
            set_window_material,
            capture_now,
            get_day_summaries,
            get_day_captures,
            get_total_capture_count,
            get_all_captures_page,
            search_captures,
            get_day_intelligence,
            get_performance_snapshot,
            export_encrypted_backup,
            import_encrypted_backup,
            get_capture_context_page,
            get_capture_image,
            update_capture_note,
            set_capture_review_state,
            get_review_shortcuts,
            redact_capture,
            get_capture_health,
            get_ocr_health,
            reindex_all_captures,
            get_storage_stats,
            delete_day,
            delete_capture
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let coordinator = app.state::<SharedState>().coordinator.clone();
                if !coordinator.shutdown_complete() {
                    api.prevent_exit();
                    if coordinator.start_shutdown() {
                        let app = app.clone();
                        // Keep the GUI pumping until the capture worker has released native
                        // resources. Native metadata/tray APIs may dispatch to the GUI thread.
                        // This is a single lifecycle task, bounded by start_shutdown's CAS.
                        tauri::async_runtime::spawn_blocking(move || {
                            coordinator.shutdown();
                            app.exit(code.unwrap_or(0));
                        });
                    }
                }
            }
        });
}

mod capture;
mod coordinator;
mod privacy;
mod storage;
mod legacy;

#[cfg(test)]
mod tests;
