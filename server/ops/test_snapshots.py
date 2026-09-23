import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("snapshots", Path(__file__).with_name("snapshots.py"))
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.live = self.root / "live.sqlite"
        self.backups = self.root / "backups"

    def tearDown(self):
        self.temp.cleanup()

    def test_committed_wal_is_in_snapshot_and_survives_restore(self):
        db = sqlite3.connect(self.live)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE samples(value INTEGER)")
            db.execute("INSERT INTO samples VALUES (20)")
            db.commit()
            complete = snapshots.snapshot(self.live, self.backups)
            restored = self.root / "restored.sqlite"
            self.assertTrue(snapshots.restore_if_missing(restored, self.backups))
            check = sqlite3.connect(restored)
            self.assertEqual(check.execute("SELECT value FROM samples").fetchall(), [(20,)])
            check.close()
            self.assertTrue(complete.exists())
        finally:
            db.close()

    def test_existing_database_is_not_overwritten(self):
        db = sqlite3.connect(self.live)
        db.execute("CREATE TABLE keep(value INTEGER)")
        db.commit()
        db.close()
        self.assertFalse(snapshots.restore_if_missing(self.live, self.backups))

    def test_corrupt_backup_fails_closed(self):
        self.backups.mkdir()
        (self.backups / "pctime-20260923T000000000000Z.sqlite").write_text("damaged")
        with self.assertRaises(sqlite3.DatabaseError):
            snapshots.restore_if_missing(self.live, self.backups)
        self.assertFalse(self.live.exists())

    def test_retention_keeps_unrelated_files(self):
        self.backups.mkdir()
        unrelated = self.backups / "manual.sqlite"
        unrelated.write_text("keep")
        db = sqlite3.connect(self.live)
        db.execute("CREATE TABLE samples(value INTEGER)")
        db.close()
        for _ in range(3):
            snapshots.snapshot(self.live, self.backups, keep=2)
        self.assertEqual(len(list(self.backups.glob("pctime-*.sqlite"))), 2)
        self.assertTrue(unrelated.exists())

    def test_orphaned_wal_requires_manual_recovery(self):
        self.live.with_name(self.live.name + "-wal").touch()
        with self.assertRaises(RuntimeError):
            snapshots.restore_if_missing(self.live, self.backups)


if __name__ == "__main__":
    unittest.main()
