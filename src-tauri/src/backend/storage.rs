//! Durable schema, file ownership/accounting, and bounded cleanup. Filesystem work never
//! holds the SQLite mutex. storage_gate serializes these operations with capture/restore.
use super::*;
use rusqlite::OptionalExtension;

const SCHEMA_VERSION: i64 = 4;
pub(super) const CLEANUP_BATCH: usize = 128;

pub(super) fn lock_archive(root: &Path) -> Result<Arc<File>, String> {
    let path = root.join(".memorylane.lock");
    validate_managed_path(root, &path)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("Cannot open archive ownership lock: {e}"))?;
    file.try_lock().map_err(|e| {
        format!("Cannot acquire archive ownership; another MemoryLane may be using it: {e}")
    })?;
    Ok(Arc::new(file))
}

pub(super) fn gate(state: &SharedState) -> std::sync::MutexGuard<'_, ()> {
    state.storage_gate.lock().unwrap_or_else(|e| e.into_inner())
}

// Validate and observe only the files owned by these rows before opening the transaction.
pub(super) fn delete_rows(
    state: &SharedState,
    day: Option<&str>,
    capture: Option<i64>,
) -> Result<(i64, Vec<PathBuf>), String> {
    let rows = with_connection(state, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id,day_key,image_path,thumbnail_path FROM captures
            WHERE (? IS NOT NULL AND day_key=?) OR (? IS NOT NULL AND id=?)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![day, day, capture, capture], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })?;
    let mut files = HashMap::new();
    for (_, day, image, thumb) in &rows {
        validate_day_key(day)?;
        for raw in [image, thumb] {
            let path = PathBuf::from(raw);
            validate_managed_path(&state.capture_dir, &path)?;
            let (bytes, id) = match fs::symlink_metadata(&path) {
                Ok(m) if m.is_file() => (m.len(), Some(identity(&path)?)),
                Ok(_) => return Err("Capture file is not a regular file".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (0, None),
                Err(e) => return Err(e.to_string()),
            };
            files.insert(path, (bytes, id));
        }
    }
    with_connection(state, |conn| {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (path, (bytes, id)) in &files {
            record_file(&tx, path, *bytes, "pending", id.as_deref())?;
        }
        for (id, _, _, _) in &rows {
            tx.execute(
                "DELETE FROM capture_search_index WHERE capture_id=?",
                params![id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM capture_annotations WHERE capture_id=?",
                params![id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM captures WHERE id=?", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        if !rows.is_empty() {
            bump_indexing_epoch(state);
        }
        Ok((rows.len() as i64, files.into_keys().collect()))
    })
}

pub(super) struct PendingCaptureFiles<'a> {
    state: &'a SharedState,
    paths: Vec<PathBuf>,
    pub committed: bool,
}
impl<'a> PendingCaptureFiles<'a> {
    pub fn new(state: &'a SharedState) -> Self {
        Self {
            state,
            paths: Vec::new(),
            committed: false,
        }
    }
    pub fn write(&mut self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        validate_managed_path(&self.state.capture_dir, path)?;
        if fs::symlink_metadata(path).is_ok() {
            return Err("Capture output already exists".into());
        }
        // Reserve a unique create_new path durably before any file can exist. A crash before
        // ownership identity is recorded leaves a staging lease, not an unrecorded orphan.
        with_connection(self.state, |conn| {
            record_file(conn, path, 0, "staging", None)
        })?;
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(file) => file,
            Err(error) => {
                // A create collision is not ours to unlink.
                with_connection(self.state, |conn| {
                    conn.execute(
                        "DELETE FROM managed_files WHERE path=?",
                        params![path.to_string_lossy()],
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(())
                })?;
                return Err(error.to_string());
            }
        };
        self.paths.push(path.to_path_buf());
        with_connection(self.state, |conn| {
            record_file(conn, path, 0, "staging", Some(&identity(path)?))
        })?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        with_connection(self.state, |conn| {
            record_file(
                conn,
                path,
                bytes.len() as u64,
                "staging",
                Some(&identity(path)?),
            )
        })
    }
    pub fn commit_files(&self, conn: &Connection) -> Result<(), String> {
        for path in &self.paths {
            conn.execute(
                "UPDATE managed_files SET state='live' WHERE path=?",
                params![path.to_string_lossy()],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
impl Drop for PendingCaptureFiles<'_> {
    fn drop(&mut self) {
        if !self.committed && !self.paths.is_empty() {
            let _storage = gate(self.state);
            // SQLite rollback has already unwound before this guard. Failures retain leases.
            let _ = cleanup_selected(self.state, true, CLEANUP_BATCH, &self.paths);
        }
    }
}

pub(super) fn enable_foreign_keys(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| e.to_string())?;
    if conn
        .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        != 1
    {
        return Err("SQLite foreign key enforcement is unavailable".into());
    }
    Ok(())
}

pub(super) fn add_column(conn: &Connection, table: &str, definition: &str) -> Result<(), String> {
    let name = definition
        .split_whitespace()
        .next()
        .ok_or("missing column name")?;
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !names.iter().any(|n| n == name) {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))
            .map_err(|e| format!("migration adding {table}.{name} failed: {e}"))?;
    }
    Ok(())
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    enable_foreign_keys(conn)?;
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!("Unsupported archive schema version {version}"));
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if version < 1 {
        super::initialize_database_v1(&tx)?;
        tx.pragma_update(None, "user_version", 1)
            .map_err(|e| e.to_string())?;
    }
    if version < 2 {
        add_column(
            &tx,
            "captures",
            "content_revision INTEGER NOT NULL DEFAULT 1",
        )?;
        add_column(&tx, "captures", "content_token TEXT NOT NULL DEFAULT ''")?;
        tx.execute_batch("DELETE FROM capture_search_index WHERE capture_id NOT IN (SELECT id FROM captures);
            DELETE FROM capture_annotations WHERE capture_id NOT IN (SELECT id FROM captures);
            ALTER TABLE capture_search_index RENAME TO old_capture_search_index;
            CREATE TABLE capture_search_index (capture_id INTEGER PRIMARY KEY,
                ocr_text TEXT NOT NULL DEFAULT '',search_text TEXT NOT NULL DEFAULT '',
                ocr_status TEXT NOT NULL DEFAULT 'pending',ocr_error TEXT,indexed_at TEXT,
                FOREIGN KEY(capture_id) REFERENCES captures(id) ON DELETE CASCADE);
            INSERT INTO capture_search_index SELECT capture_id,ocr_text,search_text,ocr_status,ocr_error,indexed_at FROM old_capture_search_index;
            DROP TABLE old_capture_search_index;
            CREATE INDEX idx_capture_search_status ON capture_search_index(ocr_status);
            ALTER TABLE capture_annotations RENAME TO old_capture_annotations;
            CREATE TABLE capture_annotations (capture_id INTEGER PRIMARY KEY,
                is_bookmarked INTEGER NOT NULL DEFAULT 0,is_favorite INTEGER NOT NULL DEFAULT 0,
                tags TEXT NOT NULL DEFAULT '[]',FOREIGN KEY(capture_id) REFERENCES captures(id) ON DELETE CASCADE);
            INSERT INTO capture_annotations SELECT capture_id,is_bookmarked,is_favorite,tags FROM old_capture_annotations;
            DROP TABLE old_capture_annotations;
            CREATE INDEX idx_capture_annotations_bookmarked ON capture_annotations(is_bookmarked);
            CREATE INDEX idx_capture_annotations_favorite ON capture_annotations(is_favorite);
            UPDATE captures SET content_token = lower(hex(randomblob(16))) WHERE content_token = '';
            CREATE TRIGGER capture_token_insert AFTER INSERT ON captures WHEN NEW.content_token = '' BEGIN
                UPDATE captures SET content_token = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
            CREATE TRIGGER capture_content_update AFTER UPDATE OF capture_note, window_title, process_name,
                image_path, thumbnail_path, width, height ON captures BEGIN
                UPDATE captures SET content_revision = OLD.content_revision + 1,
                    content_token = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
            CREATE TABLE managed_files (
                path TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes >= 0),
                state TEXT NOT NULL CHECK(state IN ('live','pending','staging','untracked')),
                identity TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
                last_error TEXT);
            CREATE INDEX managed_files_cleanup ON managed_files(state, retry_at);
            CREATE TABLE storage_accounting (id INTEGER PRIMARY KEY CHECK(id=1),
                used_bytes INTEGER NOT NULL DEFAULT 0, pending_bytes INTEGER NOT NULL DEFAULT 0,
                untracked_bytes INTEGER NOT NULL DEFAULT 0, capture_count INTEGER NOT NULL DEFAULT 0,
                reconciled INTEGER NOT NULL DEFAULT 0, last_error TEXT);
            INSERT INTO storage_accounting(id,capture_count) SELECT 1,count(*) FROM captures;
            CREATE TRIGGER storage_capture_insert AFTER INSERT ON captures BEGIN
                UPDATE storage_accounting SET capture_count=capture_count+1 WHERE id=1; END;
            CREATE TRIGGER storage_capture_delete AFTER DELETE ON captures BEGIN
                UPDATE storage_accounting SET capture_count=capture_count-1 WHERE id=1; END;
            CREATE TRIGGER storage_file_insert AFTER INSERT ON managed_files BEGIN
                UPDATE storage_accounting SET used_bytes=used_bytes+NEW.bytes,
                    pending_bytes=pending_bytes+CASE WHEN NEW.state IN ('pending','staging') THEN NEW.bytes ELSE 0 END,
                    untracked_bytes=untracked_bytes+CASE WHEN NEW.state='untracked' THEN NEW.bytes ELSE 0 END WHERE id=1; END;
            CREATE TRIGGER storage_file_delete AFTER DELETE ON managed_files BEGIN
                UPDATE storage_accounting SET used_bytes=used_bytes-OLD.bytes,
                    pending_bytes=pending_bytes-CASE WHEN OLD.state IN ('pending','staging') THEN OLD.bytes ELSE 0 END,
                    untracked_bytes=untracked_bytes-CASE WHEN OLD.state='untracked' THEN OLD.bytes ELSE 0 END WHERE id=1; END;
            CREATE TRIGGER storage_file_update AFTER UPDATE ON managed_files BEGIN
                UPDATE storage_accounting SET used_bytes=used_bytes+NEW.bytes-OLD.bytes,
                    pending_bytes=pending_bytes+CASE WHEN NEW.state IN ('pending','staging') THEN NEW.bytes ELSE 0 END
                        -CASE WHEN OLD.state IN ('pending','staging') THEN OLD.bytes ELSE 0 END,
                    untracked_bytes=untracked_bytes+CASE WHEN NEW.state='untracked' THEN NEW.bytes ELSE 0 END
                        -CASE WHEN OLD.state='untracked' THEN OLD.bytes ELSE 0 END WHERE id=1; END;")
            .map_err(|e| format!("storage schema migration failed: {e}"))?;
        tx.pragma_update(None, "user_version", 2)
            .map_err(|e| e.to_string())?;
    }
    if version < 3 {
        tx.execute_batch("CREATE INDEX IF NOT EXISTS captures_image_path ON captures(image_path);
            CREATE INDEX IF NOT EXISTS captures_thumbnail_path ON captures(thumbnail_path);
            CREATE INDEX IF NOT EXISTS managed_files_identity ON managed_files(identity,state);
            CREATE INDEX IF NOT EXISTS managed_files_error ON managed_files(last_error) WHERE last_error IS NOT NULL;")
            .map_err(|e|e.to_string())?;
        tx.pragma_update(None, "user_version", 3)
            .map_err(|e| e.to_string())?;
    }
    if version < 4 {
        add_column(&tx, "storage_accounting", "maintenance_error TEXT")?;
        tx.pragma_update(None, "user_version", 4)
            .map_err(|e| e.to_string())?;
    }
    let violation = tx
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| e.to_string())?
        .exists([])
        .map_err(|e| e.to_string())?;
    if violation {
        return Err("Archive contains inconsistent foreign keys".into());
    }
    tx.execute("UPDATE storage_accounting SET reconciled=0 WHERE id=1", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(windows)]
fn identity(path: &Path) -> Result<String, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    // Zero desired access permits identity inspection even when a read/write handle denies deletion.
    let file = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(7)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(format!(
        "{}:{}:{}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}
#[cfg(not(windows))]
fn identity(path: &Path) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(format!("{}:{}", m.dev(), m.ino()))
}

pub(super) fn record_file(
    conn: &Connection,
    path: &Path,
    bytes: u64,
    state: &str,
    file_identity: Option<&str>,
) -> Result<(), String> {
    conn.execute("INSERT INTO managed_files(path,bytes,state,identity) VALUES(?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET bytes=excluded.bytes,state=excluded.state,identity=excluded.identity,
            attempts=0,retry_at=0,last_error=NULL",
        params![path.to_string_lossy(), bytes as i64, state, file_identity]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn record_live(conn: &Connection, path: &Path) -> Result<(), String> {
    let bytes = fs::metadata(path).map_err(|e| e.to_string())?.len();
    record_file(conn, path, bytes, "live", Some(&identity(path)?))
}

pub(super) fn touch_content(conn: &Connection, capture_id: i64) -> Result<(), String> {
    conn.execute("UPDATE captures SET content_revision=content_revision+1,content_token=lower(hex(randomblob(16))) WHERE id=?",
        params![capture_id]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(super) fn after_import(state: &SharedState) -> Result<(), String> {
    // Caller holds the capture-side restore exclusion and storage gate. The worker will
    // reconcile and enforce limits as soon as restore releases its exclusion.
    with_connection(state, |conn| {
        conn.execute("UPDATE storage_accounting SET reconciled=0 WHERE id=1", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    })?;
    state.coordinator.request_maintenance(true);
    Ok(())
}

pub(super) fn validate_restore_cleanup(state: &SharedState) -> Result<(), String> {
    // The existing restore swaps the whole captures tree (recoverable swapping is unit 5).
    // Refuse that operation if it would purge files/folders outside our recorded ownership.
    // Caller holds restore exclusion and storage_gate, before committing any imported rows.
    reconcile(state)?;
    let paths = with_connection(state, |conn| {
        let unknown = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM managed_files WHERE state='untracked')",
                [],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?;
        if unknown {
            return Err("Move files outside the live archive out of the captures folder before restoring a backup".into());
        }
        let paths = conn
            .prepare("SELECT path FROM managed_files")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(paths)
    })?;
    let mut owned_directories = HashSet::new();
    for path in paths {
        let path = PathBuf::from(path);
        for parent in path
            .ancestors()
            .skip(1)
            .take_while(|p| *p != state.capture_dir)
        {
            owned_directories.insert(parent.to_path_buf());
        }
    }
    fn check(state: &SharedState, dir: &Path, owned: &HashSet<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            validate_managed_path(&state.capture_dir, &path)?;
            if path.is_dir() {
                if !owned.contains(&path) {
                    return Err("Move folders outside the live archive out of the captures folder before restoring a backup".into());
                }
                check(state, &path, owned)?;
            }
        }
        Ok(())
    }
    check(state, &state.capture_dir, &owned_directories)
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;

// Called with storage_gate held. Remove only recorded files, never unrelated day contents.
pub(super) fn cleanup(state: &SharedState, force: bool, limit: usize) -> Result<i64, String> {
    cleanup_filtered(state, force, limit, None)
}
pub(super) fn cleanup_selected(
    state: &SharedState,
    force: bool,
    limit: usize,
    paths: &[PathBuf],
) -> Result<i64, String> {
    let paths = paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let encoded = serde_json::to_string(&paths).map_err(|e| e.to_string())?;
    cleanup_filtered(state, force, limit, Some(encoded))
}
fn cleanup_filtered(
    state: &SharedState,
    force: bool,
    limit: usize,
    paths: Option<String>,
) -> Result<i64, String> {
    let now = Local::now().timestamp();
    let candidates = with_connection(state, |conn| {
        let mut stmt = conn.prepare("SELECT path,identity,state FROM managed_files
            WHERE state IN ('pending','staging') AND (?1 OR retry_at<=?2)
            AND (?4 IS NULL OR path IN (SELECT value FROM json_each(?4))) ORDER BY retry_at,path LIMIT ?3")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![force, now, limit as i64, paths], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })?;
    let mut removed = 0;
    for (path, expected, status) in candidates {
        if state.coordinator.is_shutting_down() {
            break;
        }
        let path = PathBuf::from(path);
        let result = (|| {
            validate_managed_path(&state.capture_dir, &path)?;
            let live = with_connection(state, |conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM captures WHERE image_path=? OR thumbnail_path=?)",
                    params![path.to_string_lossy(), path.to_string_lossy()],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())
            })?;
            if live {
                // Imported IDs/paths can be reused. Live references always defeat an old deletion lease.
                with_connection(state, |conn| record_live(conn, &path))?;
                return Ok(false);
            }
            match fs::symlink_metadata(&path) {
                Ok(m) => {
                    if !m.is_file() {
                        return Err("Cleanup target is not a regular file".into());
                    }
                    let actual_identity = identity(&path)?;
                    let live_identity = with_connection(state, |conn| {
                        conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM managed_files WHERE identity=? AND state='live')",
                        params![actual_identity],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())
                    })?;
                    if live_identity {
                        return Err("Cleanup target is referenced by a live image; retained".into());
                    }
                    if let Some(expected) = &expected {
                        if actual_identity != *expected {
                            return Err("Cleanup target was replaced; retained for review".into());
                        }
                    } else if status != "staging" {
                        return Err("Cleanup target has no ownership identity".into());
                    }
                    with_connection(state, |conn| {
                        conn.execute(
                            "UPDATE managed_files SET bytes=? WHERE path=?",
                            params![m.len() as i64, path.to_string_lossy()],
                        )
                        .map_err(|e| e.to_string())?;
                        Ok(())
                    })?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.to_string()),
            }
            let deleted = remove_managed_file(&state.capture_dir, &path)?;
            with_connection(state, |conn| {
                conn.execute(
                    "DELETE FROM managed_files WHERE path=?",
                    params![path.to_string_lossy()],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })?;
            if let Some(parent) = path.parent().filter(|p| *p != state.capture_dir) {
                validate_managed_path(&state.capture_dir, parent)?;
                // Only an empty directory can be removed; preserve unrelated files and junctions.
                let _ = fs::remove_dir(parent);
            }
            Ok(deleted)
        })();
        match result {
            Ok(true) => removed += 1,
            Ok(false) => (),
            Err(error) => with_connection(state, |conn| {
                conn.execute("UPDATE managed_files SET attempts=attempts+1,retry_at=?+min(3600,60*(attempts+1)),last_error=? WHERE path=?",
                    params![now,error,path.to_string_lossy()]).map_err(|e| e.to_string())?;
                Ok(())
            })?,
        }
    }
    Ok(removed)
}

// Startup/import only. A guarded walk accounts unknown files without deleting them. Failure
// leaves accounting marked incomplete and visible to the UI; subsequent maintenance retries it.
pub(super) fn reconcile(state: &SharedState) -> Result<usize, String> {
    with_connection(state, |conn| {
        conn.execute("UPDATE storage_accounting SET reconciled=0 WHERE id=1", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    })?;
    fn walk(
        state: &SharedState,
        root: &Path,
        dir: &Path,
        files: &mut Vec<(PathBuf, u64, String)>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            if state.coordinator.is_shutting_down() {
                return Err(
                    "Storage reconciliation stopped for shutdown; resumes at startup".into(),
                );
            }
            let path = entry.map_err(|e| e.to_string())?.path();
            validate_managed_path(root, &path)?;
            let m = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if m.is_dir() {
                walk(state, root, &path, files)?;
            } else if m.is_file() {
                files.push((path.clone(), m.len(), identity(&path)?));
            }
        }
        Ok(())
    }
    let live_paths = with_connection(state, |conn| {
        let paths = conn
            .prepare("SELECT image_path FROM captures UNION SELECT thumbnail_path FROM captures")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(paths)
    })?;
    let mut live_identities = HashSet::new();
    let mut missing_live = false;
    for raw in live_paths {
        if state.coordinator.is_shutting_down() {
            return Err("Storage reconciliation stopped for shutdown; resumes at startup".into());
        }
        let path = PathBuf::from(raw);
        validate_managed_path(&state.capture_dir, &path)?;
        match fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() => {
                live_identities.insert(identity(&path)?);
            }
            Ok(_) => return Err("Live capture path is not a regular file".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing_live = true,
            Err(e) => return Err(e.to_string()),
        }
    }
    let mut files = Vec::new();
    validate_managed_path(
        &state.capture_dir,
        &state.capture_dir.join("accounting_validation"),
    )?;
    walk(state, &state.capture_dir, &state.capture_dir, &mut files)?;
    let total = files.len();
    with_connection(state, |conn| {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut missing = tx
            .prepare("SELECT path FROM managed_files")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (path, bytes, id) in files {
            let key = path.to_string_lossy();
            missing.remove(key.as_ref());
            let live = live_identities.contains(&id);
            let old: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT state,identity FROM managed_files WHERE path=?",
                    params![key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let status = if live {
                "live"
            } else if old.as_ref().is_some_and(|(s, i)| {
                (s == "pending" || s == "staging") && (i.is_none() || i.as_ref() == Some(&id))
            }) {
                old.as_ref().unwrap().0.as_str()
            } else {
                "untracked"
            };
            // Preserve retry attempts/backoff for pending entries across restart.
            if let Some((old_status, old_id)) = &old {
                if old_status == status && old_id.as_ref() == Some(&id) {
                    tx.execute(
                        "UPDATE managed_files SET bytes=? WHERE path=?",
                        params![bytes as i64, key],
                    )
                    .map_err(|e| e.to_string())?;
                    continue;
                }
            }
            record_file(&tx, &path, bytes, status, Some(&id))?;
        }
        for path in missing {
            tx.execute("DELETE FROM managed_files WHERE path=?", params![path])
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE storage_accounting SET reconciled=1,last_error=? WHERE id=1",
            params![if missing_live {
                Some("Some captures have missing image files")
            } else {
                None
            }],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    })?;
    Ok(total)
}

pub(super) fn retention(state: &SharedState) -> Result<bool, String> {
    let (settings, days) = with_connection(state, |conn| {
        let settings = read_settings(conn)?;
        let days = conn
            .prepare("SELECT DISTINCT day_key FROM captures ORDER BY day_key")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok((settings, days))
    })?;
    let today = Local::now().date_naive();
    let cutoff = today
        .checked_sub_days(chrono::Days::new(
            settings.retention_days.max(1).saturating_sub(1) as u64,
        ))
        .unwrap_or(today);
    let cap = (settings.storage_cap_gb.max(0.5) * 1024.0 * 1024.0 * 1024.0) as i64;
    let mut removed = false;
    // A snapshot list is traversed once. Pending locked bytes cannot select a deleted day again.
    for day in days {
        if state.coordinator.is_shutting_down() {
            break;
        }
        validate_day_key(&day)?;
        let age = NaiveDate::parse_from_str(&day, "%Y-%m-%d").map_err(|e| e.to_string())? < cutoff;
        let retained = with_connection(state, |conn| {
            conn.query_row(
                "SELECT used_bytes-pending_bytes FROM storage_accounting WHERE id=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())
        })?;
        // Already removed files are planned reclamation, even while locked or beyond this
        // batch's unlink budget. Do not discard newer live days for the same pending bytes.
        // UI usage still reports every physical byte, including that pending reclamation.
        if age || retained > cap {
            let (count, files) = delete_rows(state, Some(&day), None)?;
            if count > 0 {
                removed = true;
            }
            cleanup_selected(state, false, CLEANUP_BATCH, &files)?;
        }
    }
    if removed {
        bump_indexing_epoch(state);
    }
    Ok(removed)
}

pub(super) fn maintenance(state: &SharedState, reconcile_requested: bool) -> Result<bool, String> {
    let _storage = gate(state);
    let needs = with_connection(state, |conn| {
        conn.query_row(
            "SELECT reconciled=0 FROM storage_accounting WHERE id=1",
            [],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())
    })?;
    if reconcile_requested || needs {
        reconcile(state)?;
    }
    cleanup(state, false, CLEANUP_BATCH)?;
    let removed = retention(state)?;
    with_connection(state, |conn| {
        conn.execute(
            "UPDATE storage_accounting SET maintenance_error=NULL WHERE id=1",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })?;
    Ok(removed)
}

pub(super) fn record_maintenance_error(state: &SharedState, error: &str) {
    let _ = with_connection(state, |conn| {
        conn.execute(
            "UPDATE storage_accounting SET maintenance_error=? WHERE id=1",
            params![error],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    });
}

pub(super) fn run_maintenance(state: &SharedState, reconcile_requested: bool) -> bool {
    let count = || {
        with_connection(state, |conn| {
            conn.query_row(
                "SELECT capture_count FROM storage_accounting WHERE id=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())
        })
    };
    let before = count();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        maintenance(state, reconcile_requested)
    }))
    .unwrap_or_else(|_| Err("Storage maintenance recovered from a panic".into()));
    if let Err(error) = result {
        record_maintenance_error(state, &error);
    }
    // The same worker is the only capture producer, and restore waits for this active work.
    // Compare visibility even after a partial failure, without conflating OCR/review changes
    // in indexing_epoch with destructive library changes.
    match (before, count()) {
        (Ok(before), Ok(after)) => before != after,
        _ => true,
    }
}
