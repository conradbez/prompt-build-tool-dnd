"""
Per-bullet file attachments, stored in an S3-compatible bucket.

Objects are written under ``sessions/<sessionId>/bullets/<bulletId>/…`` — two
levels of scope:

* **Session.** The browser mints a random id (see `src/lib/session.ts`) and
  sends it with every file request. Nothing outside that session's prefix is
  ever read, signed, deleted or attached to a prompt. The id is a bearer
  secret, not an account: it stands in for auth this prototype doesn't have.
* **Bullet.** Within a session, a run only hands a bullet the files under its
  own bullet prefix. pbt's ``promptfiles`` are global by name, so that check is
  what keeps one bullet's attachments out of another's prompt.

Downloads are served as **presigned URLs** with a short expiry, so the bytes go
straight from the bucket to the browser and a link can't be replayed for long.

Configuration is the standard AWS environment (Railway's bucket variables map
straight onto it): ``AWS_ENDPOINT_URL``, ``AWS_S3_BUCKET_NAME``,
``AWS_DEFAULT_REGION``, ``AWS_ACCESS_KEY_ID``, ``AWS_SECRET_ACCESS_KEY``.
Without them the endpoints report that uploads are switched off rather than
failing at request time.
"""

from __future__ import annotations

import io
import mimetypes
import os
import re
import uuid

BUCKET_ENV = "AWS_S3_BUCKET_NAME"


def bucket() -> str:
    return os.environ.get(BUCKET_ENV, "")


def enabled() -> bool:
    """True when the bucket is configured; the UI hides uploads otherwise."""
    return bool(bucket() and os.environ.get("AWS_ACCESS_KEY_ID"))


def _client():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("AWS_ENDPOINT_URL") or None,
        region_name=os.environ.get("AWS_DEFAULT_REGION", "auto"),
    )


def _safe_name(name: str) -> str:
    """A filename that is pleasant in a key and can't climb out of the prefix."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.basename(name)).strip("-.")
    return cleaned[:80] or "file"


def session_prefix(session_id: str) -> str:
    return f"sessions/{_safe_name(session_id)}/"


def prefix_for(session_id: str, bullet_id: str) -> str:
    return f"{session_prefix(session_id)}bullets/{_safe_name(bullet_id)}/"


def in_session(key: str, session_id: str) -> bool:
    """Whether `key` belongs to the session asking about it."""
    return bool(session_id) and key.startswith(session_prefix(session_id))


def belongs_to(key: str, session_id: str, bullet_id: str) -> bool:
    """Whether `key` is one of this session's attachments on this bullet."""
    return key.startswith(prefix_for(session_id, bullet_id))


def put(session_id: str, bullet_id: str, filename: str, data: bytes) -> dict:
    """Store one attachment and return the reference the client keeps."""
    name = _safe_name(filename)
    key = f"{prefix_for(session_id, bullet_id)}{uuid.uuid4().hex}-{name}"
    content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    _client().put_object(Bucket=bucket(), Key=key, Body=data, ContentType=content_type)
    return {"key": key, "name": os.path.basename(filename), "size": len(data)}


def get(key: str) -> io.BytesIO:
    """Fetch an attachment as a file object, which is what pbt passes along."""
    obj = _client().get_object(Bucket=bucket(), Key=key)
    buf = io.BytesIO(obj["Body"].read())
    buf.name = key.rsplit("/", 1)[-1]  # some LLM clients look for a name
    return buf


def delete(key: str) -> None:
    _client().delete_object(Bucket=bucket(), Key=key)


#: How long a download link stays good for.
LINK_TTL_SECONDS = 300


def presign(key: str, filename: str = "") -> str:
    """A short-lived URL for this one object, and nothing else.

    The disposition header rides along in the signature so the browser saves
    the file under its original name instead of navigating to it.
    """
    name = _safe_name(filename or key.rsplit("/", 1)[-1].split("-", 1)[-1])
    params = {
        "Bucket": bucket(),
        "Key": key,
        "ResponseContentDisposition": f'attachment; filename="{name}"',
    }
    return _client().generate_presigned_url(
        "get_object", Params=params, ExpiresIn=LINK_TTL_SECONDS
    )
