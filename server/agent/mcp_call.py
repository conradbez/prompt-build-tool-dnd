#!/usr/bin/env python
"""mcp-call list | mcp-call describe <tool> | mcp-call <tool> '<json args>'

Images a tool returns are saved by the daemon to /tmp/mcp_out/ and inlined
here with mini-swe-agent v2's multimodal tag, so the model sees the image
itself. MCP_INLINE_IMAGES=0 prints the file paths only.
"""
import base64
import json
import os
import re
import socket
import sys

SOCK = os.environ.get("MCP_SOCK", "/tmp/mcp.sock")
INLINE_IMAGES = os.environ.get("MCP_INLINE_IMAGES", "1") == "1"
MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "webp": "image/webp", "gif": "image/gif"}
# Providers refuse images much past 5 MB (Anthropic's cap), and one refused
# image fails the whole model call — so a bigger one is left as a path.
MAX_INLINE_BYTES = 4_500_000


def send(req):
    s = socket.socket(socket.AF_UNIX)
    s.connect(SOCK)
    s.sendall(json.dumps(req).encode() + b"\n")
    data = b""
    while chunk := s.recv(65536):
        data += chunk
    return json.loads(data)


def inline(m):
    """Swap an image marker for mini-swe-agent's multimodal tag."""
    path = m.group(1)
    ext = path.rsplit(".", 1)[-1].lower()
    if ext not in MIME or os.path.getsize(path) > MAX_INLINE_BYTES:
        return m.group(0)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return (f"[image {path}]\n<MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>image_url</CONTENT_TYPE>"
            f"data:{MIME[ext]};base64,{b64}</MSWEA_MULTIMODAL_CONTENT>")


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
    text = "\n".join(res["content"])
    if INLINE_IMAGES:
        text = re.sub(r"\[image saved to (\S+)\]", inline, text)
    print(text)
    if res["is_error"]:
        sys.exit(1)
