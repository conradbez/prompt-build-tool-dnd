"""
Sign-in by emailed one-time code, and maps kept on the server per person.

Signing in is optional: the app works in the browser alone. Once signed in, the
browser's named saves go to this server instead (see `src/lib/saves.ts`), and a
page load opens the map last edited.

    POST /auth/code    {email}        → emails a 6-digit code, good for 10 minutes
    POST /auth/verify  {email, code}  → {token, email}; the token is a bearer token
    POST /auth/logout                 → forgets the token
    GET  /maps[?name=]                → {email, maps: [{name, updated, rev}], current}
    PUT  /maps         {name, doc, rev} → stores the map's JSON under that name

`current` is the map named, or else the one saved last — `{name, doc,
updated, rev}` — or null when there are none.

`rev` counts a map's saves. A PUT names the `rev` it last saw, and is refused
with 409 (and the map's current `rev`) when the map has been saved since — by
another tab, or another device — so neither quietly overwrites the other. A PUT
without one overwrites whatever is there.

Everything lives in one SQLite file: `DB_PATH`, else `app.db` in Railway's
volume (`RAILWAY_VOLUME_MOUNT_PATH`, set when a volume is attached), else
`server/data/app.db` for local runs. Without a volume on Railway the file is
lost on every deploy.

Mail goes over JMAP to Fastmail, which is plain HTTPS: Railway blocks outbound
SMTP on every port. `FASTMAIL_API_TOKEN` (environment only) is a Fastmail API
token with mail scope, and `MAIL_FROM` must be one of that account's sending
identities. Without the token, sign-in is unavailable and says so.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import sqlite3
import threading
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

MAIL_FROM = os.environ.get("MAIL_FROM", "prompt@conradbez.com")
JMAP_SESSION_URL = "https://api.fastmail.com/jmap/session"
JMAP_USING = [
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail",
    "urn:ietf:params:jmap:submission",
]
JMAP_TIMEOUT = 20

CODE_SECONDS = 10 * 60
# Wrong guesses a code survives before it is spent.
CODE_ATTEMPTS = 5
# The least time between two codes for one address, so the form cannot be
# used to flood an inbox.
RESEND_SECONDS = 30
SESSION_SECONDS = 90 * 24 * 3600
# The largest map accepted, as JSON.
MAX_DOC_BYTES = 5 * 1024 * 1024
MAX_NAME = 60

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def mail_enabled() -> bool:
    return bool(os.environ.get("FASTMAIL_API_TOKEN"))


def _db_path() -> pathlib.Path:
    if os.environ.get("DB_PATH"):
        return pathlib.Path(os.environ["DB_PATH"])
    if os.environ.get("RAILWAY_VOLUME_MOUNT_PATH"):
        return pathlib.Path(os.environ["RAILWAY_VOLUME_MOUNT_PATH"]) / "app.db"
    return pathlib.Path(__file__).resolve().parent / "data" / "app.db"


DB_PATH = _db_path()
_lock = threading.Lock()


def _db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init() -> None:
    with _lock, _db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS codes (
                email TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL,
                expires REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                sent REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                expires REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS maps (
                email TEXT NOT NULL,
                name TEXT NOT NULL,
                doc TEXT NOT NULL,
                updated REAL NOT NULL,
                rev INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (email, name)
            );
            """
        )
        # A database from before `rev` existed.
        if "rev" not in {r["name"] for r in db.execute("PRAGMA table_info(maps)")}:
            db.execute("ALTER TABLE maps ADD COLUMN rev INTEGER NOT NULL DEFAULT 1")


_init()


def _hash(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


def _clean_email(email: str) -> str:
    email = email.strip().lower()
    if not _EMAIL.match(email) or len(email) > 254:
        raise HTTPException(400, "That does not look like an email address.")
    return email


# ---------------------------------------------------------------------------
# Mail
# ---------------------------------------------------------------------------


def _jmap(client: httpx.Client, api_url: str, calls: list) -> list:
    r = client.post(api_url, json={"using": JMAP_USING, "methodCalls": calls})
    r.raise_for_status()
    responses = r.json()["methodResponses"]
    for name, args, _ in responses:
        if name == "error":
            raise RuntimeError(f"JMAP error: {args}")
    return responses


def _identity(client: httpx.Client) -> tuple[str, str, dict, str, str]:
    """The JMAP API URL, account, MAIL_FROM's identity, and the Drafts and Sent mailboxes."""
    session = client.get(JMAP_SESSION_URL)
    session.raise_for_status()
    session = session.json()
    api_url = session["apiUrl"]
    account = session["primaryAccounts"]["urn:ietf:params:jmap:mail"]
    found = _jmap(client, api_url, [
        ["Identity/get", {"accountId": account}, "i"],
        ["Mailbox/query", {"accountId": account, "filter": {"role": "drafts"}}, "d"],
        ["Mailbox/query", {"accountId": account, "filter": {"role": "sent"}}, "s"],
    ])
    # The address itself, else a catch-all (`*@domain`) that covers it.
    identities = {i["email"].lower(): i for i in found[0][1]["list"]}
    sender = MAIL_FROM.lower()
    identity = identities.get(sender) or identities.get("*@" + sender.partition("@")[2])
    if not identity:
        raise RuntimeError(f"{MAIL_FROM} is not a sending identity on this Fastmail account.")
    return api_url, account, identity, found[1][1]["ids"][0], found[2][1]["ids"][0]


def send_mail(to: str, subject: str, text: str) -> None:
    """Send a plain-text email from MAIL_FROM through Fastmail's JMAP API.

    A draft is created and submitted in one request; on success it moves from
    Drafts to Sent, like a message sent from the Fastmail app.
    """
    headers = {"Authorization": f"Bearer {os.environ['FASTMAIL_API_TOKEN']}"}
    with httpx.Client(headers=headers, timeout=JMAP_TIMEOUT) as client:
        api_url, account, identity, drafts, sent = _identity(client)
        done = _jmap(client, api_url, [
            ["Email/set", {
                "accountId": account,
                "create": {"draft": {
                    "from": [{"email": MAIL_FROM, "name": identity.get("name") or ""}],
                    "to": [{"email": to}],
                    "subject": subject,
                    "keywords": {"$draft": True, "$seen": True},
                    "mailboxIds": {drafts: True},
                    "bodyValues": {"body": {"value": text}},
                    "textBody": [{"partId": "body", "type": "text/plain"}],
                }},
            }, "e"],
            ["EmailSubmission/set", {
                "accountId": account,
                "create": {"send": {"identityId": identity["id"], "emailId": "#draft"}},
                "onSuccessUpdateEmail": {"#send": {
                    f"mailboxIds/{drafts}": None,
                    f"mailboxIds/{sent}": True,
                    "keywords/$draft": None,
                }},
            }, "s"],
        ])
        for _, args, tag in done:
            if args.get("notCreated"):
                raise RuntimeError(f"JMAP {tag} failed: {args['notCreated']}")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

router = APIRouter()


class CodeRequest(BaseModel):
    email: str


class VerifyRequest(BaseModel):
    email: str
    code: str


class SaveRequest(BaseModel):
    name: str
    doc: dict[str, Any]
    # The map's `rev` this save is based on; None overwrites whatever is there.
    rev: Optional[int] = None


@router.get("/auth/enabled")
def auth_enabled() -> dict:
    return {"enabled": mail_enabled()}


@router.post("/auth/code")
def request_code(req: CodeRequest) -> dict:
    if not mail_enabled():
        raise HTTPException(503, "Sign-in is not set up on this server (no FASTMAIL_API_TOKEN).")
    email = _clean_email(req.email)
    now = time.time()
    with _lock, _db() as db:
        row = db.execute("SELECT sent FROM codes WHERE email = ?", (email,)).fetchone()
        if row and now - row["sent"] < RESEND_SECONDS:
            raise HTTPException(429, f"A code was just sent. Try again in {RESEND_SECONDS} seconds.")
        code = f"{secrets.randbelow(1_000_000):06d}"
        db.execute(
            "INSERT OR REPLACE INTO codes (email, code_hash, expires, attempts, sent) VALUES (?, ?, ?, 0, ?)",
            (email, _hash(email, code), now + CODE_SECONDS, now),
        )
    try:
        send_mail(
            email,
            f"Your sign-in code: {code}",
            f"Your sign-in code is {code}\n\nIt works for {CODE_SECONDS // 60} minutes. "
            "If you did not ask for it, ignore this email.\n",
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[accounts] sending a code to {email} failed: {exc}", flush=True)
        raise HTTPException(502, "The code could not be emailed. Try again shortly.") from exc
    return {"ok": True}


@router.post("/auth/verify")
def verify_code(req: VerifyRequest) -> dict:
    email = _clean_email(req.email)
    code = re.sub(r"\D", "", req.code)
    now = time.time()
    with _lock, _db() as db:
        row = db.execute("SELECT * FROM codes WHERE email = ?", (email,)).fetchone()
        if not row or row["expires"] < now or row["attempts"] >= CODE_ATTEMPTS:
            raise HTTPException(400, "That code has expired. Ask for a new one.")
        if not hmac.compare_digest(row["code_hash"], _hash(email, code)):
            db.execute("UPDATE codes SET attempts = attempts + 1 WHERE email = ?", (email,))
            raise HTTPException(400, "That code is not right.")
        db.execute("DELETE FROM codes WHERE email = ?", (email,))
        token = secrets.token_urlsafe(32)
        db.execute(
            "INSERT INTO sessions (token_hash, email, expires) VALUES (?, ?, ?)",
            (_hash(token), email, now + SESSION_SECONDS),
        )
        db.execute("DELETE FROM sessions WHERE expires < ?", (now,))
    return {"token": token, "email": email}


def _user(authorization: Optional[str]) -> str:
    """The signed-in email behind a `Bearer` token, or a 401."""
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token:
        with _lock, _db() as db:
            row = db.execute(
                "SELECT email FROM sessions WHERE token_hash = ? AND expires > ?",
                (_hash(token), time.time()),
            ).fetchone()
        if row:
            return row["email"]
    raise HTTPException(401, "Not signed in.")


def user_or_none(authorization: Optional[str]) -> Optional[str]:
    """The signed-in email behind a `Bearer` token, or None."""
    try:
        return _user(authorization)
    except HTTPException:
        return None


@router.post("/auth/logout")
def logout(authorization: Optional[str] = Header(None)) -> dict:
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token:
        with _lock, _db() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))
    return {"ok": True}


@router.get("/maps")
def get_maps(name: Optional[str] = None, authorization: Optional[str] = Header(None)) -> dict:
    email = _user(authorization)
    with _lock, _db() as db:
        rows = db.execute(
            "SELECT name, updated, rev FROM maps WHERE email = ? ORDER BY updated DESC", (email,)
        ).fetchall()
        if name is not None:
            cur = db.execute(
                "SELECT name, doc, updated, rev FROM maps WHERE email = ? AND name = ?", (email, name)
            ).fetchone()
        else:
            cur = db.execute(
                "SELECT name, doc, updated, rev FROM maps WHERE email = ? ORDER BY updated DESC LIMIT 1",
                (email,),
            ).fetchone()
    return {
        "email": email,
        "maps": [{"name": r["name"], "updated": r["updated"], "rev": r["rev"]} for r in rows],
        "current": (
            {"name": cur["name"], "doc": json.loads(cur["doc"]), "updated": cur["updated"], "rev": cur["rev"]}
            if cur
            else None
        ),
    }


@router.put("/maps")
def save_map(req: SaveRequest, authorization: Optional[str] = Header(None)) -> dict:
    email = _user(authorization)
    name = req.name.strip()[:MAX_NAME]
    if not name:
        raise HTTPException(400, "A map needs a name.")
    doc = json.dumps(req.doc, separators=(",", ":"))
    if len(doc) > MAX_DOC_BYTES:
        raise HTTPException(413, "This map is too large to save.")
    now = time.time()
    with _lock, _db() as db:
        row = db.execute(
            "SELECT rev FROM maps WHERE email = ? AND name = ?", (email, name)
        ).fetchone()
        if row and req.rev is not None and row["rev"] != req.rev:
            raise HTTPException(
                409,
                {"message": f"“{name}” was saved somewhere else since this copy was opened.", "rev": row["rev"]},
            )
        rev = (row["rev"] if row else 0) + 1
        db.execute(
            "INSERT OR REPLACE INTO maps (email, name, doc, updated, rev) VALUES (?, ?, ?, ?, ?)",
            (email, name, doc, now, rev),
        )
    return {"ok": True, "updated": now, "rev": rev}
