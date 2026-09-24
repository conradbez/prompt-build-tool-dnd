#!/usr/bin/env python
"""Launch a stdio MCP server, keep one session open, serve calls on a unix socket.

Usage: mcp_daemon.py <server command> [args...]

Runs *inside* an agent bullet's sandbox, as its main process. mini-swe-agent
runs each command in a fresh shell, so it cannot hold an MCP session itself;
this does, which keeps the server's state (open files, CAD sessions, DB
connections) alive across the agent's steps. The agent reaches it through
`mcp-call` (see `mcp_call.py`).
"""
import asyncio
import base64
import json
import os
import sys

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


async def main():
    params = StdioServerParameters(command=sys.argv[1], args=sys.argv[2:], env=dict(os.environ))
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as session:
            await session.initialize()
            lock = asyncio.Lock()  # one call at a time

            async def handle(reader, writer):
                try:
                    req = json.loads(await reader.readline())
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
                except Exception as e:
                    resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                writer.write(json.dumps(resp).encode() + b"\n")
                await writer.drain()
                writer.close()

            if os.path.exists(SOCK):
                os.remove(SOCK)
            server = await asyncio.start_unix_server(handle, path=SOCK)
            print("mcp daemon ready", flush=True)
            async with server:
                await server.serve_forever()


asyncio.run(main())
