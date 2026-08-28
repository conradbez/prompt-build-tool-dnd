"""
Per-bullet file attachments, stored in an S3-compatible bucket.

Files belong to a bullet, not to the document: every object is written under
``bullets/<bulletId>/…``, and a run will only hand a bullet the files sitting
under its own prefix. pbt's ``promptfiles`` are global by name, so that prefix
check is what keeps one bullet's attachments out of another's prompt.

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


def prefix_for(bullet_id: str) -> str:
    return f"bullets/{_safe_name(bullet_id)}/"


def belongs_to(key: str, bullet_id: str) -> bool:
    """Whether `key` is one of `bullet_id`'s own attachments."""
    return key.startswith(prefix_for(bullet_id))


def put(bullet_id: str, filename: str, data: bytes) -> dict:
    """Store one attachment and return the reference the client keeps."""
    name = _safe_name(filename)
    key = f"{prefix_for(bullet_id)}{uuid.uuid4().hex}-{name}"
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
