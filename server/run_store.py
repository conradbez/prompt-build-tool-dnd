"""
Each person's promptmap run database, kept on the volume.

promptmap keeps every bullet's past results in a SQLite file. Those results back
the cache and `{{ previous }}`, which is how a chat bullet remembers its
conversation (see `main._chat_transcript`). Each person gets their own file:
the signed-in email if there is one, else the browser's session id. So one
person's history never shows up as another person's `previous`, and one
person's answers are never served from another person's cache. The file lives
next to `accounts.DB_PATH`, so it is on the Railway volume when one is attached.

promptmap keys history by *model name*, and the app names models after bullet
titles (`export.model_names`). A table in the same file remembers which name
each bullet ran under last time. Before a run, `follow_names` moves history to
the new name with promptmap's own `rename_model`, so retitling a bullet keeps
its history. A bullet that wants a name another bullet holds (two maps that
both have a "Summary") parks the other bullet's history under a name of its own
until it runs again.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import threading
from contextlib import closing
from pathlib import Path

from promptmap.storage.memory import MemoryStorageBackend
from promptmap.storage.sqlite import SQLiteStorageBackend

import accounts

ROOT = accounts.DB_PATH.parent / "runs"

_locks: dict[Path, threading.Lock] = {}
_locks_guard = threading.Lock()


def path_for(user: str) -> Path | None:
    """This person's database file, or None with no one to key it to."""
    user = user.strip()
    if not user:
        return None
    # Hashed: an email or a session id never becomes a path as-is.
    return ROOT / (hashlib.sha256(user.encode()).hexdigest()[:32] + ".db")


def storage_for(user: str):
    """The storage backend for one person's run. A request with no user gets
    one that forgets everything after the run, rather than a shared file."""
    path = path_for(user)
    if path is None:
        return MemoryStorageBackend()
    path.parent.mkdir(parents=True, exist_ok=True)
    storage = SQLiteStorageBackend(path)
    storage.init_db()
    return storage


def _lock(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


def _parked(bullet_id: str) -> str:
    """Where a bullet's history waits while another bullet holds its name."""
    return "_bullet_" + re.sub(r"[^A-Za-z0-9_-]", "_", bullet_id)


def follow_names(storage, id_to_name: dict[str, str]) -> None:
    """Move each bullet's history to the name it runs under now.

    Takes *id_to_name* (bullet id → model name for this run) and records it in
    the database once each bullet's rows sit under its new name.
    """
    if not isinstance(storage, SQLiteStorageBackend):
        return  # nothing kept between runs, so nothing to move
    path = Path(storage.db_path())
    # Autocommit: `rename_model` writes on its own connection, which an open
    # transaction here would lock out.
    with _lock(path), closing(sqlite3.connect(path, isolation_level=None)) as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS app_bullet_names ("
            "bullet_id TEXT PRIMARY KEY, model_name TEXT NOT NULL UNIQUE)"
        )
        names = dict(db.execute("SELECT bullet_id, model_name FROM app_bullet_names"))
        holder = {name: bid for bid, name in names.items()}

        def move(bid: str, new: str) -> None:
            old = names.get(bid)
            if old == new:
                return
            if old is not None:
                storage.rename_model(old, new)
                del holder[old]
            names[bid] = new
            holder[new] = bid
            db.execute(
                "INSERT INTO app_bullet_names (bullet_id, model_name) VALUES (?, ?) "
                "ON CONFLICT(bullet_id) DO UPDATE SET model_name = excluded.model_name",
                (bid, new),
            )

        # Two passes, so names can swap within one run (two bullets trading
        # titles). First, every bullet whose name changes steps aside...
        for bid, new in id_to_name.items():
            if names.get(bid) not in (None, new):
                move(bid, _parked(bid))
        # ...then takes its name, first parking whichever bullet outside this
        # run still holds it.
        for bid, new in id_to_name.items():
            other = holder.get(new)
            if other is not None and other != bid:
                move(other, _parked(other))
            move(bid, new)
