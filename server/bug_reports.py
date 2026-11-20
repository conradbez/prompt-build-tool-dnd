"""Bug reports: a note plus the last ~180s of the page (see `src/bugReport/`).

Self-contained: one table in the accounts database, three routes. The client
posts `{events, logs}` gzip'd; it is stored as-is and handed back gzip'd for
the browser to unpack. `/bug-reports/<VIEW_CODE>` lists the reports with an
rrweb player — the code is the only guard, so change it to revoke a link.
"""

import json
import time
import zlib
from typing import Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response

import accounts

VIEW_CODE = "6449b571"
MAX_GZ = 25 * 1024 * 1024
MAX_JSON = 200 * 1024 * 1024  # gzip-bomb guard

router = APIRouter()

with accounts._lock, accounts._db() as _db:
    _db.execute(
        """CREATE TABLE IF NOT EXISTS bug_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created REAL NOT NULL,
            description TEXT NOT NULL, url TEXT, user_agent TEXT, email TEXT,
            duration REAL, data_gz BLOB NOT NULL)"""
    )


def _duration(raw: bytes) -> float:
    d = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        body = json.loads(d.decompress(raw, MAX_JSON))
        assert not d.unconsumed_tail and isinstance(body["events"], list) and body["events"]
        stamps = [e["timestamp"] for e in body["events"]]
        return (max(stamps) - min(stamps)) / 1000
    except Exception:
        raise HTTPException(400, "Bad recording.")


@router.post("/bug-reports")
async def create(
    description: str = Form(...),
    url: str = Form(""),
    userAgent: str = Form(""),
    data: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
) -> dict:
    raw = await data.read(MAX_GZ + 1)
    if len(raw) > MAX_GZ:
        raise HTTPException(413, "Recording too large.")
    row = (time.time(), description.strip()[:4000], url[:2000], userAgent[:500],
           accounts.user_or_none(authorization), _duration(raw), raw)
    with accounts._lock, accounts._db() as db:
        cur = db.execute(
            "INSERT INTO bug_reports (created, description, url, user_agent, email, duration, data_gz)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)", row)
    return {"id": cur.lastrowid}


def _guard(code: str) -> None:
    if code != VIEW_CODE:
        raise HTTPException(404, "Not Found")


@router.get("/bug-reports/{code}/{report_id}")
def report_data(code: str, report_id: int) -> Response:
    _guard(code)
    with accounts._lock, accounts._db() as db:
        row = db.execute("SELECT data_gz FROM bug_reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        raise HTTPException(404, "No such report.")
    return Response(row["data_gz"], media_type="application/json", headers={"Content-Encoding": "gzip"})


@router.get("/bug-reports/{code}", response_class=HTMLResponse)
def page(code: str) -> HTMLResponse:
    _guard(code)
    with accounts._lock, accounts._db() as db:
        rows = db.execute(
            "SELECT id, created, description, url, user_agent, email, duration"
            " FROM bug_reports ORDER BY created DESC").fetchall()
    data = json.dumps([dict(r) for r in rows]).replace("</", "<\\/")
    return HTMLResponse(_PAGE.replace("__REPORTS__", data).replace("__CODE__", code),
                        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})


_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Bug reports</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@2.2.0/dist/style.css">
<style>
body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1d2330;background:#f6f7f9;display:grid;grid-template-columns:320px 1fr;height:100vh}
aside{overflow:auto;background:#fff;border-right:1px solid #e3e6eb}main{overflow:auto;padding:20px}
.r{padding:10px 14px;border-bottom:1px solid #e3e6eb;cursor:pointer;white-space:pre-wrap;word-break:break-word}
.r:hover{background:#f2f4fb}.r.on{background:#e9edff}.m{color:#6b7280;font-size:12px;word-break:break-all}
h2{font-size:16px;margin:0 0 4px;white-space:pre-wrap}pre{background:#fff;border:1px solid #e3e6eb;padding:8px;font-size:12px;white-space:pre-wrap;max-height:30vh;overflow:auto}
@media(max-width:800px){body{display:block;height:auto}aside{max-height:40vh}}
</style></head><body><aside id="list"></aside><main id="detail"></main>
<script src="https://cdn.jsdelivr.net/npm/rrweb-player@2.2.0/umd/rrweb-player.min.js"></script>
<script>
const reports = __REPORTS__, $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const meta = (r) => `#${r.id} · ${new Date(r.created * 1000).toLocaleString()} · ${Math.round(r.duration)}s`;
function list(on) {
  $('#list').innerHTML = reports.map((r) => `<div class="r${r.id === on ? ' on' : ''}" onclick="show(${r.id})">
    ${esc(r.description)}<div class="m">${meta(r)}${r.email ? ' · ' + esc(r.email) : ''}</div></div>`).join('')
    || '<p class="r">No reports yet.</p>';
}
async function show(id) {
  const r = reports.find((x) => x.id === id);
  location.hash = id; list(id);
  $('#detail').innerHTML = `<h2>${esc(r.description)}</h2><div class="m">${meta(r)}<br>${esc(r.email)}<br>
    ${esc(r.url)}<br>${esc(r.user_agent)}</div><div id="player">Loading…</div><pre id="logs"></pre>`;
  const { events, logs } = await (await fetch(`/bug-reports/__CODE__/${id}`)).json();
  $('#player').innerHTML = '';
  const w = Math.min($('#player').clientWidth || 900, 1400);
  new rrwebPlayer.Player({ target: $('#player'), props: { events, width: w, height: Math.round(w * 0.56) } });
  $('#logs').textContent = logs.length ? logs.map((l) => `${new Date(l.ts).toLocaleTimeString()} [${l.level}] ${l.msg}`).join('\\n')
    : 'No console errors or failed requests.';
}
list();
const start = +location.hash.slice(1) || reports[0]?.id;
if (start) show(start);
</script></body></html>"""
