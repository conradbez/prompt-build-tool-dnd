#!/usr/bin/env python
"""Launch a stdio MCP server, keep one session open, serve calls on a unix socket.

Usage: mcp_daemon.py <server command> [args...]

Runs *inside* an agent bullet's sandbox, as its main process. mini-swe-agent
runs each command in a fresh shell, so it cannot hold an MCP session itself;
this does, which keeps the server's state (open files, CAD sessions, DB
connections) alive across the agent's steps. The agent reaches it through
`mcp-call` (see `mcp_call.py`).

Each request is logged to stdout as `<epoch seconds> <what happened>`, so the
server can merge it into the bullet's end-to-end log (see `agent_exec.py`).
"""
import asyncio
import base64
import json
import os
import sys
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SOCK = os.environ.get("MCP_SOCK", "/tmp/mcp.sock")
OUT_DIR = "/tmp/mcp_out"
os.makedirs(OUT_DIR, exist_ok=True)
counter = 0


def serialize(content):
    """Text stays text; images/binary get saved to disk and returned as a path."""
    global counter
    out = []
    for c in content:
        if c.type == "text":
            out.append(c.text)
        elif c.type == "image":
            counter += 1
            ext = c.mimeType.split("/")[-1]
            path = f"{OUT_DIR}/out_{counter}.{ext}"
            with open(path, "wb") as f:
                f.write(base64.b64decode(c.data))
            out.append(f"[image saved to {path}]")
        else:
            out.append(f"[{c.type} content]")
    return out


def log(message):
    print(f"{time.time():.3f} {message}", flush=True)


def _short(value, limit=200):
    text = json.dumps(value)
    return text if len(text) <= limit else text[:limit] + "…"


async def main():
    params = StdioServerParameters(command=sys.argv[1], args=sys.argv[2:], env=dict(os.environ))
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as session:
            await session.initialize()
            lock = asyncio.Lock()  # one call at a time

            async def handle(reader, writer):
                started = time.time()
                what = "?"
                try:
                    req = json.loads(await reader.readline())
                    what = "list tools" if req["op"] == "list" else f"call {req['tool']} {_short(req.get('args', {}))}"
                    async with lock:
                        if req["op"] == "list":
                            tools = (await session.list_tools()).tools
                            result = [
                                {
                                    "name": t.name,
                                    "description": t.description or "",
                                    "schema": t.inputSchema,
                                }
                                for t in tools
                            ]
                        else:
                            res = await session.call_tool(req["tool"], req.get("args", {}))
                            result = {"is_error": bool(res.isError), "content": serialize(res.content)}
                    resp = {"ok": True, "result": result}
                    failed = isinstance(result, dict) and result["is_error"]
                    log(f"{what} -> {'tool error' if failed else 'ok'} in {time.time() - started:.1f}s")
                except Exception as e:
                    resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                    log(f"{what} -> {resp['error']} in {time.time() - started:.1f}s")
                writer.write(json.dumps(resp).encode() + b"\n")
                await writer.drain()
                writer.close()

            if os.path.exists(SOCK):
                os.remove(SOCK)
            server = await asyncio.start_unix_server(handle, path=SOCK)
            log(f"MCP server ready: {' '.join(sys.argv[1:])}")
            async with server:
                await server.serve_forever()


asyncio.run(main())
