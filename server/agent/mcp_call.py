#!/usr/bin/env python
"""mcp-call list | mcp-call describe <tool> | mcp-call <tool> '<json args>'"""
import json
import os
import socket
import sys

SOCK = os.environ.get("MCP_SOCK", "/tmp/mcp.sock")


def send(req):
    s = socket.socket(socket.AF_UNIX)
    s.connect(SOCK)
    s.sendall(json.dumps(req).encode() + b"\n")
    data = b""
    while chunk := s.recv(65536):
        data += chunk
    return json.loads(data)


if len(sys.argv) < 2:
    sys.exit(__doc__)

if not os.path.exists(SOCK):
    sys.exit("No MCP server is running in this sandbox — this task has no MCP tools.")

cmd = sys.argv[1]
if cmd in ("list", "describe"):
    if cmd == "describe" and len(sys.argv) < 3:
        sys.exit("Usage: mcp-call describe <tool>")
    resp = send({"op": "list"})
else:
    try:
        args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    except json.JSONDecodeError as e:
        sys.exit(f"Bad JSON args: {e}")
    resp = send({"op": "call", "tool": cmd, "args": args})

if not resp["ok"]:
    sys.exit(f"ERROR: {resp['error']}")

res = resp["result"]
if cmd == "list":
    for t in res:
        print(f"{t['name']} - {t['description'].splitlines()[0] if t['description'] else ''}")
elif cmd == "describe":
    match = [t for t in res if t["name"] == sys.argv[2]]
    print(json.dumps(match[0], indent=2) if match else f"No tool named {sys.argv[2]}")
else:
    print("\n".join(res["content"]))
    if res["is_error"]:
        sys.exit(1)
