"""Consistent local SQLite snapshots; only completed files are copied to NAS."""
import argparse
from contextlib import closing
import datetime
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import tempfile
import threading
import time


def validate(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise RuntimeError("SQLite integrity check failed")


def durable_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as output, open(source, "rb") as input_file:
            shutil.copyfileobj(input_file, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def snapshot(database, destination, keep=60):
    if not database.exists():
        return None
    fd, temporary = tempfile.mkstemp(prefix="snapshot-", suffix=".sqlite", dir=database.parent)
    os.close(fd)
    local = Path(temporary)
    started = time.monotonic()

    def progress(*_):
        if time.monotonic() - started > 30:
            raise TimeoutError("SQLite snapshot exceeded 30 seconds")

    try:
        with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)) as source, closing(sqlite3.connect(local)) as target:
            source.backup(target, pages=128, progress=progress, sleep=0.05)
            target.execute("PRAGMA journal_mode=DELETE")
        validate(local)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        published = destination / ("pctime-" + stamp + ".sqlite")
        durable_copy(local, published)
        # Only prune this tool's complete snapshots, after publishing a valid new one.
        for old in sorted(destination.glob("pctime-????????T????????????Z.sqlite"), reverse=True)[keep:]:
            old.unlink()
        return published
    finally:
        local.unlink(missing_ok=True)


def restore_if_missing(database, destination):
    if database.exists():
        validate(database)
        return False
    if database.with_name(database.name + "-wal").exists():
        raise RuntimeError("Orphaned WAL exists; manual recovery is required")
    candidates = sorted(destination.glob("pctime-????????T????????????Z.sqlite"), reverse=True)
    if not candidates:
        return False
    # Fail closed if the newest backup is damaged; do not silently roll back accounts.
    database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staged = database.with_name(database.name + ".restore")
    try:
        durable_copy(candidates[0], staged)
        validate(staged)
        os.replace(staged, database)
    finally:
        staged.unlink(missing_ok=True)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["once", "restore", "watch"])
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backups", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "restore":
        print("Restored latest snapshot" if restore_if_missing(args.database, args.backups) else "Local database retained or first start", flush=True)
        return
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    while True:
        try:
            result = snapshot(args.database, args.backups)
            if result:
                status = {"ok": True, "snapshot": result.name, "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                args.database.with_name("backup-status.json").write_text(json.dumps(status), encoding="utf-8")
                print("Snapshot completed: " + result.name, flush=True)
        except Exception as error:
            print("Snapshot failed: " + type(error).__name__, flush=True)
            if args.action == "once":
                raise
        if args.action == "once" or stopped.wait(60 if args.database.exists() else 1):
            break
    if args.action == "watch" and args.database.exists():
        snapshot(args.database, args.backups)


if __name__ == "__main__":
    main()
