use super::*;

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, Connection) {
    let temp = tempfile::TempDir::new().unwrap();
    let source = temp.path().join("legacy");
    let current = temp.path().join("current");
    let root = source.join("captures/2026-10-03");
    fs::create_dir_all(&root).unwrap();
    let image = root.join("one.png");
    let thumb = root.join("one_thumb.jpg");
    image::RgbImage::from_pixel(32, 32, image::Rgb([12, 50, 90]))
        .save(&image)
        .unwrap();
    image::RgbImage::from_pixel(8, 8, image::Rgb([12, 50, 90]))
        .save(&thumb)
        .unwrap();
    let conn = Connection::open(source.join(DB_FILENAME)).unwrap();
    super::super::initialize_database_v1(&conn).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute("INSERT INTO captures(id,day_key,captured_at,image_path,thumbnail_path,width,height,capture_note)
        VALUES(7,'2026-10-03','now',?,?,32,32,'source note')",params![image.to_string_lossy(),thumb.to_string_lossy()]).unwrap();
    conn.execute_batch("INSERT INTO capture_annotations(capture_id,is_favorite,tags) VALUES(7,1,'[\"tag\"]');
        INSERT INTO capture_search_index(capture_id,ocr_text,search_text,ocr_status) VALUES(7,'source OCR','source search','ready');").unwrap();
    (temp, source, current, conn)
}

fn capture_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM captures", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn consistent_wal_snapshot_rebases_paths_preserves_source_and_ignores_later_source_changes() {
    let (_temp, source, current, conn) = fixture();
    assert!(source.join("memorylane.db-wal").exists());
    migrate(&current,&source,|phase| {
        if phase=="staged" {conn.execute_batch("INSERT INTO captures(day_key,captured_at,image_path,thumbnail_path,width,height)
            SELECT day_key,'later',image_path,thumbnail_path,width,height FROM captures WHERE id=7;").unwrap();}
        Ok(())
    }).unwrap();
    assert_eq!(capture_count(&conn), 2);
    let destination = Connection::open(current.join(DB_FILENAME)).unwrap();
    initialize_database(&destination).unwrap();
    assert_eq!(capture_count(&destination), 1);
    let (image, thumb, note): (String, String, String) = destination
        .query_row(
            "SELECT image_path,thumbnail_path,capture_note FROM captures WHERE id=7",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert!(Path::new(&image).starts_with(current.join("captures")));
    assert!(Path::new(&thumb).starts_with(current.join("captures")));
    assert!(Path::new(&image).is_file());
    assert_eq!(note, "source note");
    assert_eq!(
        destination
            .query_row(
                "SELECT ocr_text FROM capture_search_index WHERE capture_id=7",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "source OCR"
    );
    let source_path: String = conn
        .query_row("SELECT image_path FROM captures WHERE id=7", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        fs::canonicalize(source_path).unwrap(),
        fs::canonicalize(source.join("captures/2026-10-03/one.png")).unwrap()
    );
    migrate(&current, &source, |_| {
        panic!("completed migration must not run again")
    })
    .unwrap();
    assert_eq!(capture_count(&destination), 1);
}

#[test]
fn every_installation_phase_recovers_on_restart_without_modifying_source() {
    for failed in [
        "before_snapshot",
        "staged",
        "prepared",
        "captures_installed",
        "db_installed",
        "completed",
    ] {
        let (_temp, source, current, conn) = fixture();
        assert!(
            migrate(&current, &source, |phase| if phase == failed {
                Err("injected interruption".into())
            } else {
                Ok(())
            })
            .unwrap_err()
            .contains("injected interruption"),
            "failure did not reach {failed}"
        );
        migrate(&current, &source, |_| Ok(())).unwrap();
        let destination = Connection::open(current.join(DB_FILENAME)).unwrap();
        initialize_database(&destination).unwrap();
        assert_eq!(capture_count(&destination), 1, "failed phase {failed}");
        assert_eq!(capture_count(&conn), 1);
        assert!(source.join("captures/2026-10-03/one.png").exists());
        assert!(journal_path(&current).unwrap().join("decision").exists());
        assert!(!journal_path(&current).unwrap().starts_with(&current));
    }
}

#[test]
fn populated_empty_and_deleted_current_archives_are_never_replaced() {
    for rows in [0, 1] {
        let (_temp, source, current, conn) = fixture();
        fs::create_dir(&current).unwrap();
        let destination = Connection::open(current.join(DB_FILENAME)).unwrap();
        initialize_database(&destination).unwrap();
        if rows == 1 {
            destination.execute_batch("INSERT INTO captures(id,day_key,captured_at,image_path,thumbnail_path,width,height)
            VALUES(100,'2026-10-03','current','current.png','current_thumb.jpg',1,1);").unwrap();
        }
        migrate(&current, &source, |_| {
            panic!("initialized archive must not stage legacy data")
        })
        .unwrap();
        assert_eq!(capture_count(&destination), rows);
        destination.execute("DELETE FROM captures", []).unwrap();
        // New source rows and intentional deletion cannot reopen the external decision.
        conn.execute_batch("INSERT INTO captures(day_key,captured_at,image_path,thumbnail_path,width,height)
            SELECT day_key,'later',image_path,thumbnail_path,width,height FROM captures WHERE id=7;").unwrap();
        migrate(&current, &source, |_| {
            panic!("deleted archive must remain empty")
        })
        .unwrap();
        assert_eq!(capture_count(&destination), 0);
    }
}

#[test]
fn uninitialized_destination_with_unrelated_files_is_preserved() {
    let (_temp, source, current, _conn) = fixture();
    fs::create_dir_all(current.join("captures")).unwrap();
    fs::write(current.join("captures/keep.txt"), b"keep").unwrap();
    migrate(&current, &source, |_| {
        panic!("occupied destination must not stage")
    })
    .unwrap();
    assert!(!current.join(DB_FILENAME).exists());
    assert_eq!(
        fs::read(current.join("captures/keep.txt")).unwrap(),
        b"keep"
    );
}

#[test]
fn archive_initialized_after_preparation_is_not_overwritten() {
    let (_temp, source, current, _conn) = fixture();
    assert!(migrate(&current, &source, |phase| if phase == "prepared" {
        Err("interrupted".into())
    } else {
        Ok(())
    })
    .is_err());
    let destination = Connection::open(current.join(DB_FILENAME)).unwrap();
    initialize_database(&destination).unwrap();
    assert!(migrate(&current, &source, |_| Ok(()))
        .unwrap_err()
        .contains("refusing legacy replacement"));
    assert_eq!(capture_count(&destination), 0);
    assert!(!current.join("captures").exists());
}

#[test]
fn damaged_staging_is_refused_and_incomplete_manifest_can_be_rebuilt() {
    let (_temp, source, current, _conn) = fixture();
    assert!(migrate(&current, &source, |phase| if phase == "staged" {
        Err("interrupted".into())
    } else {
        Ok(())
    })
    .is_err());
    fs::write(
        journal_path(&current).unwrap().join("prepared.pending"),
        b"partial JSON",
    )
    .unwrap();
    migrate(&current, &source, |_| Ok(())).unwrap();
    assert!(current.join(DB_FILENAME).exists());
    let (_temp, source, current, _conn) = fixture();
    assert!(migrate(&current, &source, |phase| if phase == "prepared" {
        Err("interrupted".into())
    } else {
        Ok(())
    })
    .is_err());
    fs::write(
        journal_path(&current)
            .unwrap()
            .join("captures/2026-10-03/one.png"),
        b"changed",
    )
    .unwrap();
    assert!(migrate(&current, &source, |_| Ok(())).is_err());
    assert!(!current.join(DB_FILENAME).exists());
    assert!(source.join("captures/2026-10-03/one.png").exists());
}

#[test]
fn valid_image_header_with_truncated_pixels_is_rejected_then_recoverable() {
    let (_temp, source, current, _conn) = fixture();
    let image = source.join("captures/2026-10-03/one.png");
    let complete = fs::read(&image).unwrap();
    fs::write(&image, &complete[..48]).unwrap();
    assert!(
        image::image_dimensions(&image).is_ok(),
        "fixture still has its valid PNG dimensions"
    );
    assert!(migrate(&current, &source, |_| Ok(()))
        .unwrap_err()
        .contains("Invalid legacy image"));
    assert!(!current.join(DB_FILENAME).exists());
    fs::write(&image, &complete).unwrap();
    migrate(&current, &source, |_| Ok(())).unwrap();
    assert!(current.join(DB_FILENAME).exists());
}
