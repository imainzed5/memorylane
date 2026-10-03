//! One-time migration decision and installation journal live beside the archive, outside
//! backup/restore scope. Existing archives always win, including intentionally empty ones.
use super::*;
use sha2::Digest;
use std::io::Read;

#[derive(Serialize, Deserialize)]
struct Manifest {
    db_hash: String,
    files: Vec<(String, String)>,
}

fn hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let n = file.read(&mut bytes).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&bytes[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}
fn regular(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() && !is_filesystem_indirection(&m) => Ok(true),
        Ok(_) => Err("Legacy migration journal or database is redirected".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
pub(super) fn journal_path(current: &Path) -> Result<PathBuf, String> {
    let parent = current.parent().ok_or("Archive has no parent directory")?;
    let name = current
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Archive has no directory name")?;
    Ok(parent.join(format!("{name}.legacy-migration-v1")))
}

fn verify_files(root: &Path, manifest: &Manifest) -> Result<(), String> {
    validate_capture_root_tree(root)?;
    fn list(root: &Path, dir: &Path, result: &mut HashSet<String>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            validate_managed_path(root, &path)?;
            if path.is_dir() {
                list(root, &path, result)?;
            } else {
                result.insert(
                    path.strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        Ok(())
    }
    let mut actual = HashSet::new();
    list(root, root, &mut actual)?;
    let expected = manifest
        .files
        .iter()
        .map(|(p, _)| p.clone())
        .collect::<HashSet<_>>();
    if actual != expected {
        return Err(
            "Interrupted legacy installation has unexpected files; archive left intact".into(),
        );
    }
    for (rel, expected_hash) in &manifest.files {
        let path = root.join(normalize_backup_relative_path(rel)?);
        validate_managed_path(root, &path)?;
        if hash(&path)? != *expected_hash {
            return Err("Legacy image changed during migration; archive left intact".into());
        }
        image::image_dimensions(&path).map_err(|e| format!("Legacy image is invalid: {e}"))?;
    }
    Ok(())
}

pub(super) fn migrate(
    current: &Path,
    source: &Path,
    mut fault: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let journal = journal_path(current)?;
    let parent = journal.parent().ok_or("Migration journal has no parent")?;
    validate_managed_path(parent, &journal)?;
    validate_managed_path(parent, current)?;
    fs::create_dir_all(current).map_err(|e| e.to_string())?;
    validate_managed_path(parent, current)?;
    if regular(&journal.join("decision"))? {
        return Ok(());
    }
    if !journal.exists() {
        fs::create_dir(&journal).map_err(|e| e.to_string())?;
    }
    validate_managed_tree(parent, &journal)?;
    let staged_db = journal.join(DB_FILENAME);
    let staged_captures = journal.join("captures");
    let prepared = journal.join("prepared.json");
    let destination_db = current.join(DB_FILENAME);
    let destination_captures = current.join("captures");
    if !regular(&prepared)? {
        let initialized = regular(&destination_db)?
            || if destination_captures.exists() {
                validate_capture_root_tree(&destination_captures)?;
                fs::read_dir(&destination_captures)
                    .map_err(|e| e.to_string())?
                    .next()
                    .is_some()
            } else {
                false
            };
        if initialized || current == source || !regular(&source.join(DB_FILENAME))? {
            write_new(
                &journal.join("decision"),
                b"Existing archive preserved or no legacy archive; automatic migration is closed.",
            )?;
            return Ok(());
        }
        // Retry only our known incomplete staging assets. Never remove destination/source trees.
        if staged_captures.exists() {
            remove_managed_tree(&journal, &staged_captures)?;
        }
        for name in [
            DB_FILENAME,
            "memorylane.db-journal",
            "memorylane.db-wal",
            "memorylane.db-shm",
            "prepared.pending",
        ] {
            let path = journal.join(name);
            if regular(&path)? {
                remove_managed_file(&journal, &path)?;
            }
        }
        fault("before_snapshot")?;
        validate_managed_path(source, &source.join(DB_FILENAME))?;
        let source_db = Connection::open_with_flags(
            source.join(DB_FILENAME),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())?;
        storage::enable_foreign_keys(&source_db)?;
        // SQLite's consistent snapshot includes committed WAL pages; raw copying the DB does not.
        source_db
            .execute("VACUUM INTO ?", params![staged_db.to_string_lossy()])
            .map_err(|e| format!("Legacy SQLite snapshot failed: {e}"))?;
        drop(source_db);
        let staged = Connection::open(&staged_db).map_err(|e| e.to_string())?;
        initialize_database(&staged)?;
        staged
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(|e| e.to_string())?;
        fs::create_dir(&staged_captures).map_err(|e| e.to_string())?;
        let rows = staged
            .prepare("SELECT id,day_key,image_path,thumbnail_path FROM captures")
            .map_err(|e| e.to_string())?
            .query_map([], |r| {
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
        let source_captures = source.join("captures");
        let mut files = HashMap::new();
        let tx = staged.unchecked_transaction().map_err(|e| e.to_string())?;
        for (id, day, image, thumb) in rows {
            validate_day_key(&day)?;
            let mut destinations = Vec::new();
            for raw in [&image, &thumb] {
                let source_path = PathBuf::from(raw);
                validate_managed_path(&source_captures, &source_path)?;
                let rel = source_path
                    .strip_prefix(&source_captures)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                let rel_path = normalize_backup_relative_path(&rel)?;
                let staged_path = staged_captures.join(&rel_path);
                fs::create_dir_all(staged_path.parent().ok_or("Legacy image has no parent")?)
                    .map_err(|e| e.to_string())?;
                validate_managed_path(&staged_captures, &staged_path)?;
                let before = hash(&source_path)?;
                if !staged_path.exists() {
                    fs::copy(&source_path, &staged_path).map_err(|e| e.to_string())?;
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&staged_path)
                        .map_err(|e| e.to_string())?
                        .sync_all()
                        .map_err(|e| e.to_string())?;
                }
                if hash(&staged_path)? != before || hash(&source_path)? != before {
                    return Err(
                        "Legacy source image changed while staging; retry on next startup".into(),
                    );
                }
                image::open(&staged_path).map_err(|e| format!("Invalid legacy image: {e}"))?;
                files.insert(rel, before);
                destinations.push(
                    destination_captures
                        .join(rel_path)
                        .to_string_lossy()
                        .to_string(),
                );
            }
            tx.execute(
                "UPDATE captures SET image_path=?,thumbnail_path=? WHERE id=?",
                params![destinations[0], destinations[1], id],
            )
            .map_err(|e| e.to_string())?;
        }
        // The old ledger points into the old archive; destination accounting is rebuilt at startup.
        tx.execute("DELETE FROM managed_files", [])
            .map_err(|e| e.to_string())?;
        tx.execute("UPDATE storage_accounting SET reconciled=0 WHERE id=1", [])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(staged);
        fs::OpenOptions::new()
            .write(true)
            .open(&staged_db)
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        fault("staged")?;
        let mut files = files.into_iter().collect::<Vec<_>>();
        files.sort();
        let manifest = Manifest {
            db_hash: hash(&staged_db)?,
            files,
        };
        verify_files(&staged_captures, &manifest)?;
        let pending_manifest = journal.join("prepared.pending");
        write_new(
            &pending_manifest,
            &serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
        )?;
        fs::rename(&pending_manifest, &prepared).map_err(|e| e.to_string())?;
        fault("prepared")?;
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(&prepared).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if regular(&destination_db)? && hash(&destination_db)? != manifest.db_hash {
        return Err("Archive initialized after staging; refusing legacy replacement".into());
    }
    if staged_captures.exists() {
        verify_files(&staged_captures, &manifest)?;
        if destination_captures.exists() {
            validate_capture_root_tree(&destination_captures)?;
            // Only an empty uninitialized directory can make room for installation.
            fs::remove_dir(&destination_captures)
                .map_err(|e| format!("Legacy destination is occupied: {e}"))?;
        }
        fs::rename(&staged_captures, &destination_captures).map_err(|e| e.to_string())?;
    }
    verify_files(&destination_captures, &manifest)?;
    fault("captures_installed")?;
    if regular(&destination_db)? {
        if hash(&destination_db)? != manifest.db_hash {
            return Err("Legacy destination database changed; refusing replacement".into());
        }
    } else {
        if !regular(&staged_db)? || hash(&staged_db)? != manifest.db_hash {
            return Err("Staged legacy database is missing or changed".into());
        }
        fs::rename(&staged_db, &destination_db).map_err(|e| e.to_string())?;
    }
    fault("db_installed")?;
    write_new(
        &journal.join("decision"),
        b"Legacy migration completed; source preserved. Never migrate automatically again.",
    )?;
    fault("completed")?;
    Ok(())
}

#[cfg(test)]
#[path = "legacy_tests.rs"]
mod tests;
