"""Bug reports: a short description plus a replay of the last few minutes.

The page records itself with rrweb (see `src/lib/bugRecorder.ts`) and, when
someone presses the bug button, posts the last ~180 seconds of events
gzip-compressed alongside their note. Reports land in the accounts database
(`bug_reports` table).

There is no admin account: `/bug-reports/<code>` lists every report with a
player, and the code below is the only thing guarding it. Anyone with the link
sees the reports — recordings can hold whatever was on screen (password inputs
are masked by rrweb).
"""

from __future__ import annotations

import html
import json
import time
import zlib
from typing import Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response

import accounts

# The secret in `/bug-reports/<code>`. Hard-coded on purpose: change it here to
# revoke a leaked link.
VIEW_CODE = "6449b571"

MAX_GZIP_BYTES = 25 * 1024 * 1024
# Guards against a gzip bomb when the upload is checked.
MAX_JSON_BYTES = 200 * 1024 * 1024
MAX_DESCRIPTION = 4000
# rrweb-player, loaded from a CDN on the viewing page only.
PLAYER_VERSION = "2.2.0"

router = APIRouter()


def _init() -> None:
    with accounts._lock, accounts._db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS bug_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created REAL NOT NULL,
                description TEXT NOT NULL,
                url TEXT NOT NULL DEFAULT '',
                user_agent TEXT NOT NULL DEFAULT '',
                email TEXT,
                duration REAL NOT NULL DEFAULT 0,
                events_gz BLOB NOT NULL
            )
            """
        )


_init()


def _check_events(raw: bytes) -> float:
    """Validate the gzip'd rrweb events; return the recording's length in seconds."""
    d = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        data = d.decompress(raw, MAX_JSON_BYTES)
        if d.unconsumed_tail:
            raise HTTPException(413, "This recording is too large.")
        events = json.loads(data)
    except (zlib.error, ValueError):
        raise HTTPException(400, "The recording is not gzip'd JSON.")
    if not isinstance(events, list) or not events:
        raise HTTPException(400, "The recording has no events.")
    stamps = [e.get("timestamp") for e in events if isinstance(e, dict)]
    stamps = [t for t in stamps if isinstance(t, (int, float))]
    return (max(stamps) - min(stamps)) / 1000 if stamps else 0.0


@router.post("/bug-reports")
async def create_report(
    description: str = Form(...),
    url: str = Form(""),
    userAgent: str = Form(""),
    events: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
) -> dict:
    description = description.strip()[:MAX_DESCRIPTION]
    if not description:
        raise HTTPException(400, "Say what went wrong.")
    raw = await events.read(MAX_GZIP_BYTES + 1)
    if len(raw) > MAX_GZIP_BYTES:
        raise HTTPException(413, "This recording is too large.")
    duration = _check_events(raw)
    email = accounts.user_or_none(authorization)
    with accounts._lock, accounts._db() as db:
        cur = db.execute(
            "INSERT INTO bug_reports (created, description, url, user_agent, email, duration, events_gz)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (time.time(), description, url[:2000], userAgent[:500],
             email, duration, raw),
        )
    return {"ok": True, "id": cur.lastrowid}


def _guard(code: str) -> None:
    if code != VIEW_CODE:
        raise HTTPException(404, "Not Found")


@router.get("/bug-reports/{code}/{report_id}/events")
def report_events(code: str, report_id: int) -> Response:
    _guard(code)
    with accounts._lock, accounts._db() as db:
        row = db.execute("SELECT events_gz FROM bug_reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        raise HTTPException(404, "No such report.")
    # Stored gzip'd: the browser unpacks it.
    return Response(
        row["events_gz"],
        media_type="application/json",
        headers={"Content-Encoding": "gzip", "Cache-Control": "private, max-age=86400"},
    )


@router.post("/bug-reports/{code}/{report_id}/delete")
def delete_report(code: str, report_id: int) -> dict:
    _guard(code)
    with accounts._lock, accounts._db() as db:
        db.execute("DELETE FROM bug_reports WHERE id = ?", (report_id,))
    return {"ok": True}


@router.get("/bug-reports/{code}", response_class=HTMLResponse)
def list_reports(code: str) -> HTMLResponse:
    _guard(code)
    with accounts._lock, accounts._db() as db:
        rows = db.execute(
            "SELECT id, created, description, url, user_agent, email, duration,"
            " length(events_gz) AS size FROM bug_reports ORDER BY created DESC"
        ).fetchall()
    reports = [
        {
            "id": r["id"],
            "created": r["created"],
            "description": r["description"],
            "url": r["url"],
            "userAgent": r["user_agent"],
            "email": r["email"],
            "duration": r["duration"],
            "size": r["size"],
        }
        for r in rows
    ]
    # `</` cannot close the script tag from inside the JSON.
    data = json.dumps(reports).replace("</", "<\\/")
    page = _PAGE.replace("__REPORTS__", data).replace("__CODE__", html.escape(code)).replace(
        "__PLAYER__", PLAYER_VERSION
    )
    return HTMLResponse(page, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Bug reports</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@__PLAYER__/dist/style.css">
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#6b7280; --border:#e3e6eb; --accent:#4f6bed; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  .wrap { display:grid; grid-template-columns: 340px 1fr; height:100vh; }
  aside { border-right:1px solid var(--border); overflow:auto; background:var(--card); }
  h1 { font-size:15px; margin:0; padding:14px 16px; border-bottom:1px solid var(--border); }
  .item { padding:12px 16px; border-bottom:1px solid var(--border); cursor:pointer; }
  .item:hover { background:#f2f4fb; }
  .item.on { background:#e9edff; }
  .desc { white-space:pre-wrap; word-break:break-word; display:-webkit-box;
          -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .meta { color:var(--muted); font-size:12px; margin-top:4px; }
  main { overflow:auto; padding:20px; }
  .detail h2 { font-size:16px; margin:0 0 6px; white-space:pre-wrap; word-break:break-word; font-weight:600; }
  .detail .meta { margin-bottom:14px; }
  .detail button { border:1px solid var(--border); background:#fff; border-radius:6px;
                   padding:4px 10px; cursor:pointer; font:inherit; }
  .detail button:hover { border-color:#d33; color:#d33; }
  #player { margin-top:12px; }
  .empty { color:var(--muted); padding:16px; }
  @media (max-width: 800px) {
    .wrap { grid-template-columns: 1fr; height:auto; }
    aside { max-height:40vh; border-right:none; border-bottom:1px solid var(--border); }
    main { padding:16px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <aside>
    <h1 id="count">Bug reports</h1>
    <div id="list"></div>
  </aside>
  <main><div id="detail" class="detail"><p class="empty">Pick a report.</p></div></main>
</div>
<script src="https://cdn.jsdelivr.net/npm/rrweb-player@__PLAYER__/umd/rrweb-player.min.js"></script>
<script>
const CODE = "__CODE__";
let reports = __REPORTS__;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when = (t) => new Date(t * 1000).toLocaleString();
const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

function renderList(activeId) {
  $('#count').textContent = `Bug reports (${reports.length})`;
  $('#list').innerHTML = reports.length ? reports.map((r) => `
    <div class="item${r.id === activeId ? ' on' : ''}" data-id="${r.id}">
      <div class="desc">${esc(r.description)}</div>
      <div class="meta">#${r.id} · ${esc(when(r.created))} · ${Math.round(r.duration)}s${r.email ? ' · ' + esc(r.email) : ''}</div>
    </div>`).join('') : '<p class="empty">No reports yet.</p>';
  for (const el of document.querySelectorAll('.item'))
    el.onclick = () => show(Number(el.dataset.id));
}

async function show(id) {
  const r = reports.find((x) => x.id === id);
  if (!r) return;
  history.replaceState(null, '', '#' + id);
  renderList(id);
  $('#detail').innerHTML = `
    <h2>${esc(r.description)}</h2>
    <div class="meta">#${r.id} · ${esc(when(r.created))} · ${Math.round(r.duration)}s recorded · ${kb(r.size)}
      ${r.email ? '<br>' + esc(r.email) : ''}
      ${r.url ? '<br>' + esc(r.url) : ''}
      ${r.userAgent ? '<br>' + esc(r.userAgent) : ''}</div>
    <button id="del">Delete</button>
    <div id="player"><p class="empty">Loading recording…</p></div>`;
  $('#del').onclick = async () => {
    if (!confirm('Delete report #' + id + '?')) return;
    await fetch(`/bug-reports/${CODE}/${id}/delete`, { method: 'POST' });
    reports = reports.filter((x) => x.id !== id);
    $('#detail').innerHTML = '<p class="empty">Deleted.</p>';
    renderList();
  };
  try {
    const res = await fetch(`/bug-reports/${CODE}/${id}/events`);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const events = await res.json();
    const box = $('#player');
    if (!box) return;
    box.innerHTML = '';
    const width = Math.max(320, Math.min(box.clientWidth || 900, 1400));
    const Player = rrwebPlayer.Player || rrwebPlayer.default || rrwebPlayer;
    new Player({ target: box, props: { events, width, height: Math.round(width * 0.56), autoPlay: false, showWarning: false } });
  } catch (e) {
    $('#player').innerHTML = '<p class="empty">Could not load the recording: ' + esc(e.message) + '</p>';
  }
}

renderList();
const start = Number(location.hash.slice(1)) || (reports[0] && reports[0].id);
if (start) show(start);
</script>
</body>
</html>
"""
