"""
FastAPI application factory for the pbt server.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import pathlib
import tempfile
import traceback
from typing import Any, List, Optional

# ── Session file storage ───────────────────────────────────────────────────────
# Files are stored under their content hash (first 16 hex chars of SHA-256).
# The session index maps session_id → {original_filename: hash16}.
UPLOADS_DIR = pathlib.Path(tempfile.gettempdir()) / "pbt_uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

_sessions: dict[str, dict[str, str]] = {}  # session_id → {"key.ext": "hash16"}

try:
    from fastapi import FastAPI, File, Form, Query, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import Response
    from pydantic import BaseModel
except ImportError as exc:
    raise ImportError(
        "utils.server requires FastAPI and uvicorn. "
        "Install them with: pip install fastapi uvicorn"
    ) from exc

import pbt

# Maps output_extension config values to HTTP Content-Type headers.
_EXTENSION_CONTENT_TYPE: dict[str, str] = {
    "html": "text/html; charset=utf-8",
    "json": "application/json",
    "md":   "text/markdown; charset=utf-8",
    "txt":  "text/plain; charset=utf-8",
    "csv":  "text/csv; charset=utf-8",
    "xml":  "application/xml; charset=utf-8",
}


def _raw_response(
    serialised: dict[str, Any],
    output_model: str | None,
    model_extensions: dict[str, str],
) -> "Response | None":
    """Return a raw Response with the correct Content-Type when ``output_model``
    is set and that model has ``output_extension`` configured.  Returns None
    otherwise (caller should fall back to the normal RunResponse JSON path)."""
    if output_model is None or output_model not in model_extensions:
        return None
    if output_model not in serialised:
        return None
    ext = model_extensions[output_model]
    content_type = _EXTENSION_CONTENT_TYPE.get(ext, "text/plain; charset=utf-8")
    return Response(content=str(serialised[output_model]), media_type=content_type)


class RunResponse(BaseModel):
    outputs: dict[str, Any]
    errors: list[str] = []


def _log_exception(context: str, exc: Exception) -> None:
    print(f"[pbt-server] {context}: {exc}")
    print(traceback.format_exc())


def _log_run_errors(errors: list[str]) -> None:
    if not errors:
        return
    print("[pbt-server] run returned errors:")
    for error in errors:
        print(f"[pbt-server]   {error}")


def _log_latest_db_errors() -> None:
    try:
        latest_runs = pbt.db.get_latest_runs(1)
        if not latest_runs:
            return
        run_id = latest_runs[0]["run_id"]
        rows = pbt.db.get_run_results(run_id)
    except Exception as exc:
        print(f"[pbt-server] failed to inspect pbt db for detailed errors: {exc}")
        return

    detailed_rows = [row for row in rows if row["status"] == "error" and row["error"]]
    if not detailed_rows:
        return

    print(f"[pbt-server] latest run detailed model errors (run_id={run_id}):")
    for row in detailed_rows:
        print(f"[pbt-server]   {row['model_name']}: {row['error']}")



def _filter_output(serialised: dict[str, Any], output_model: str | None) -> dict[str, Any]:
    """Return only the requested model's output, or all outputs if not specified."""
    if output_model is None:
        return serialised
    if output_model not in serialised:
        raise KeyError(output_model)
    return {output_model: serialised[output_model]}


def _serialise(outputs: dict) -> tuple[dict[str, Any], list[str]]:
    serialised: dict[str, Any] = {}
    errors: list[str] = []
    for name, value in outputs.items():
        if isinstance(value, pbt.ModelError):
            errors.append(f"{name}: {value.message}")
        elif isinstance(value, pbt.ModelStatus):
            errors.append(f"{name}: {value.value}")
        else:
            serialised[name] = value
    return serialised, errors


def _parse_promptdata(promptdata_json: str | None) -> dict | None:
    """Parse the JSON-encoded promptdata form field, or return None."""
    if not promptdata_json:
        return None
    try:
        parsed = json.loads(promptdata_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"promptdata must be a valid JSON object, got: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("promptdata must be a JSON object (dict), not a list or scalar.")
    return parsed or None


def _parse_promptfiles(uploads: list[UploadFile] | None) -> dict | None:
    """
    Convert a list of uploaded files into the ``promptfiles`` dict expected by
    ``pbt.run()``.  Each file's ``filename`` (without extension) is used as the
    promptfile key, so the caller should name files to match the keys declared
    in the model's ``# pbt:config promptfiles:`` block.

    Example: upload a file named ``doc.pdf`` → key ``"doc"``.
    If the filename has no extension the full filename is used as the key.
    """
    if not uploads:
        return None
    result: dict = {}
    for upload in uploads:
        raw_name = upload.filename or ""
        # Strip extension to get the key (e.g. "doc.pdf" → "doc")
        key = raw_name.rsplit(".", 1)[0] if "." in raw_name else raw_name
        if not key:
            key = raw_name
        result[key] = upload.file  # SpooledTemporaryFile satisfies IO[bytes]
    return result or None


def _inline_template_source(source: str) -> str:
    return "{{skip_and_set_to_value(" + json.dumps(source) + ")}}"


def _build_run_endpoint(
    models_dir: str,
    validation_dir: str,
    dag_promptdata: list[str],
    dag_promptfiles: list[str],
    model_extensions: dict[str, str] | None = None,
):
    """
    Dynamically build a /run function whose signature lists each detected
    promptdata() key as an optional query parameter. FastAPI reads __signature__
    to generate the OpenAPI schema, so every key shows up in /docs.

    promptfiles cannot be passed via GET (no file uploads), but they are
    documented in the endpoint description.
    """

    _model_extensions = model_extensions or {}

    def _run(**kwargs: Any) -> RunResponse:
        output_model = kwargs.pop("output_model", None)
        provided = {k: v for k, v in kwargs.items() if v is not None}
        try:
            outputs = pbt.run(
                models_dir=models_dir,
                promptdata=provided or None,
                validation_dir=validation_dir,
                verbose=False,
            )
        except Exception as exc:
            _log_exception("GET /run failed", exc)
            return RunResponse(outputs={}, errors=[str(exc)])
        serialised, errors = _serialise(outputs)
        _log_run_errors(errors)
        _log_latest_db_errors()
        raw = _raw_response(serialised, output_model, _model_extensions)
        if raw is not None:
            return raw
        try:
            serialised = _filter_output(serialised, output_model)
        except KeyError:
            return RunResponse(outputs={}, errors=[f"output_model '{output_model}' not found in run results"])
        return RunResponse(outputs=serialised, errors=errors)

    # Build a signature: one Optional[str] query param per detected promptdata key,
    # plus a fixed output_model param.
    params = [
        inspect.Parameter(
            key_name,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            default=Query(None, description=f"Template variable: `{{{{ promptdata('{key_name}') }}}}`"),
            annotation=Optional[str],
        )
        for key_name in dag_promptdata
    ]
    params.append(
        inspect.Parameter(
            "output_model",
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            default=Query(None, description="If provided, only return this model's output."),
            annotation=Optional[str],
        )
    )
    _run.__signature__ = inspect.Signature(params)

    promptfiles_note = (
        "\n\n**Required promptfiles** (upload via `POST /run`):\n"
        + "\n".join(f"- `{v}`" for v in dag_promptfiles)
        if dag_promptfiles
        else ""
    )

    description = (
        "Run all pbt prompt models and return their outputs.\n\n"
        + (
            "**Detected template variables** (from `promptdata()` usage in `.prompt` files):\n"
            + "\n".join(f"- `{v}`" for v in dag_promptdata)
            if dag_promptdata
            else "_No promptdata() variables detected in current models._"
        )
        + promptfiles_note
        + (
            "\n\n> **Note:** File uploads (`promptfiles`) are only supported via `POST /run`."
            if dag_promptfiles
            else ""
        )
    )
    _run.__doc__ = description

    return _run


def create_app(
    models_dir: str = "models",
    validation_dir: str = "validation",
) -> FastAPI:
    """
    Create and return a FastAPI app that exposes pbt over HTTP.

    The /run endpoint's query parameters are built dynamically from the vars
    detected across all .prompt files via static promptdata() scanning at startup.
    """
    # Import DAG helpers once at create_app() time — avoids repeated per-request
    # import overhead and surfaces import errors at startup rather than on first call.
    from pbt.executor.graph import (
        load_models, get_dag_promptdata, get_dag_promptfiles,
    )

    # Detect promptdata() keys and promptfile names at startup so the OpenAPI
    # schema is accurate.
    try:
        models = load_models(models_dir)
        dag_promptdata = get_dag_promptdata(models)
        dag_promptfiles = get_dag_promptfiles(models)
        model_extensions = {
            name: m.config["output_extension"]
            for name, m in models.items()
            if "output_extension" in m.config
        }
    except Exception:
        dag_promptdata = []
        dag_promptfiles = []
        model_extensions = {}

    app = FastAPI(
        title="pbt server",
        description=(
            "Run pbt prompt models via HTTP. "
            "Query parameters on `/run` are auto-generated from `promptdata()` "
            "usage detected in your `.prompt` files. "
            "File inputs (`promptfiles`) are accepted as multipart uploads on `POST /run`."
        ),
        version=pbt.__version__,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict:
        return {
            "status": "ok",
            "pbt_version": pbt.__version__,
            "dag_promptdata": dag_promptdata,
            "dag_promptfiles": dag_promptfiles,
        }

    # POST /run — multipart/form-data so that both text variables (promptdata)
    # and file uploads (promptfiles) can be included in the same request.
    #
    # promptdata  : JSON-encoded dict, e.g. '{"country": "USA"}'
    # select      : repeated form field, e.g. select=tweet&select=haiku
    # <any file>  : uploaded file; filename (without extension) is the promptfile key
    @app.post("/run", response_model=RunResponse, summary="Run models (multipart form)")
    async def run_post(
        promptdata: Optional[str] = Form(
            None,
            description=(
                "JSON-encoded dict of template variables, e.g. "
                '`{"country": "USA", "tone": "formal"}`. '
                "Matches `promptdata()` calls in `.prompt` templates."
            ),
        ),
        select: Optional[List[str]] = Form(
            None,
            description="Limit execution to these model names (and their upstream dependencies).",
        ),
        output_model: Optional[str] = Form(
            None,
            description="If provided, only return this model's output instead of all outputs.",
        ),
        promptfiles: Optional[List[UploadFile]] = File(
            None,
            description=(
                "Files required by models that declare `promptfiles` in their config block. "
                "Each file's **filename** (without extension) is used as the promptfile key, "
                "so name your upload to match the key declared in the model "
                "(e.g. upload `doc.pdf` for `promptfiles: doc`)."
                + (
                    f" Detected keys in current models: {', '.join(f'`{v}`' for v in dag_promptfiles)}."
                    if dag_promptfiles
                    else ""
                )
            ),
        ),
    ) -> RunResponse:
        """
        Run pbt models. Accepts multipart/form-data so file inputs (promptfiles)
        can be uploaded alongside text variables (promptdata).

        **promptdata** — JSON object string with template variables.\n
        **select** — repeated field to limit which models run.\n
        **output_model** — if set, only this model's output is returned.\n
        **promptfiles** — one file per declared promptfile key; use the key as the filename
        (with any extension), e.g. `doc.pdf` → key `doc`.
        """
        try:
            pd = _parse_promptdata(promptdata)
        except ValueError as exc:
            return RunResponse(outputs={}, errors=[str(exc)])

        pf = _parse_promptfiles(promptfiles)

        try:
            outputs = pbt.run(
                models_dir=models_dir,
                select=select,
                promptdata=pd,
                promptfiles=pf,
                validation_dir=validation_dir,
                verbose=False,
            )
        except Exception as exc:
            _log_exception("POST /run failed", exc)
            return RunResponse(outputs={}, errors=[str(exc)])
        serialised, errors = _serialise(outputs)
        _log_run_errors(errors)
        _log_latest_db_errors()
        raw = _raw_response(serialised, output_model, model_extensions)
        if raw is not None:
            return raw
        try:
            serialised = _filter_output(serialised, output_model)
        except KeyError:
            return RunResponse(outputs={}, errors=[f"output_model '{output_model}' not found in run results"])
        return RunResponse(outputs=serialised, errors=errors)

    # GET /run — dynamic query params per detected promptdata key (for the docs UI).
    # File uploads are not possible via GET; use POST /run for promptfiles.
    run_get = _build_run_endpoint(models_dir, validation_dir, dag_promptdata, dag_promptfiles, model_extensions)
    app.get("/run", response_model=RunResponse, summary="Run models (query params)")(run_get)

    # -----------------------------------------------------------------------
    # File upload endpoint — stores files by content hash, keyed by session
    # -----------------------------------------------------------------------

    @app.post(
        "/files/upload",
        summary="Upload files to session storage",
        tags=["DAG editor"],
    )
    async def upload_files(
        session_id: str = Form(..., description="Client session identifier."),
        files: List[UploadFile] = File(..., description="Files to store. The filename (with extension) becomes the session key; the stem is used as the promptfile key on run."),
    ) -> dict:
        """
        Store uploaded files under their SHA-256 content hash (first 16 hex chars).
        The session index maps ``original_filename → hash16`` so the same file is
        never written twice and each run can look up files by session.
        """
        uploaded: dict[str, str] = {}
        if session_id not in _sessions:
            _sessions[session_id] = {}
        for upload in files:
            content = await upload.read()
            hash16 = hashlib.sha256(content).hexdigest()[:16]
            dest = UPLOADS_DIR / hash16
            if not dest.exists():
                dest.write_bytes(content)
            original_name = upload.filename or hash16
            _sessions[session_id][original_name] = hash16
            uploaded[original_name] = hash16
        return {"session_id": session_id, "uploaded": uploaded}

    # -----------------------------------------------------------------------
    # DAG endpoint — used by the drag-and-drop front-end (utils/dnd-front-end)
    # -----------------------------------------------------------------------

    @app.post(
        "/dag/run",
        response_model=RunResponse,
        summary="Run models from a DAG defined inline",
        tags=["DAG editor"],
    )
    async def run_dag(
        nodes: str = Form(
            ...,
            description='JSON array of {"name": "...", "source": "..."} objects.',
        ),
        select: Optional[List[str]] = Form(
            None,
            description="Model names to run (and their upstream dependencies). Repeat for multiple.",
        ),
        promptdata: Optional[str] = Form(
            None,
            description='JSON-encoded dict of template variables, e.g. `{"topic": "AI"}`.',
        ),
        promptfiles: Optional[List[UploadFile]] = File(
            None,
            description=(
                "Files required by models that declare `promptfiles` in their config block. "
                "Each file's filename (without extension) is used as the promptfile key."
            ),
        ),
        session_id: Optional[str] = Form(
            None,
            description="Session ID from /files/upload. Pre-uploaded files for this session are merged into promptfiles.",
        ),
        provider: str = Form(
            "gemini",
            description="Selected LLM provider: gemini, openai, or anthropic.",
        ),
        api_key: Optional[str] = Form(
            None,
            description="Provider API key. If omitted, the server environment variable is used.",
        ),
    ) -> RunResponse:
        """
        Build and execute a DAG from inline node definitions in a single request.
        No separate registration step required — pbt handles caching internally.
        """
        from client import make_llm_call
        if provider not in {"gemini", "openai", "anthropic"}:
            return RunResponse(outputs={}, errors=[f"Unsupported provider: {provider}"])

        llm_call_fn = make_llm_call(api_key=api_key, provider=provider)

        try:
            nodes_list = json.loads(nodes)
            models_dict = {
                n["name"]: _inline_template_source(n["source"]) if n.get("isTemplate") else n["source"]
                for n in nodes_list
            }
        except Exception as exc:
            return RunResponse(outputs={}, errors=[f"Invalid nodes payload: {exc}"])

        try:
            pd = _parse_promptdata(promptdata)
        except ValueError as exc:
            return RunResponse(outputs={}, errors=[str(exc)])

        pf = _parse_promptfiles(promptfiles)

        # Merge pre-uploaded session files (don't overwrite explicitly uploaded ones)
        if session_id and session_id in _sessions:
            if pf is None:
                pf = {}
            for original_name, hash16 in _sessions[session_id].items():
                file_path = UPLOADS_DIR / hash16
                if not file_path.exists():
                    continue
                key = original_name.rsplit(".", 1)[0] if "." in original_name else original_name
                if key not in pf:
                    pf[key] = open(file_path, "rb")
            if not pf:
                pf = None

        session_files = _sessions.get(session_id, {}) if session_id else {}
        print("[pbt-server] dag/run models:")
        for name, source in models_dict.items():
            print(f"  [{name}]\n{source}\n")
        print(f"[pbt-server] session files available: {list(session_files.keys()) if session_files else 'none'}")
        print(f"[pbt-server] promptfiles passed to pbt: {list(pf.keys()) if pf else None}")

        # Track file handles opened from disk so we can close them after the run
        opened_files = [f for f in (pf or {}).values() if hasattr(f, "name")]

        try:
            outputs = pbt.run(
                models_from_dict=models_dict,
                select=select or None,
                promptdata=pd,
                promptfiles=pf,
                llm_call=llm_call_fn,
                verbose=False,
            )
        except Exception as exc:
            _log_exception("POST /dag/run failed", exc)
            return RunResponse(outputs={}, errors=[str(exc)])
        finally:
            for f in opened_files:
                try:
                    f.close()
                except Exception:
                    pass
        serialised, errors = _serialise(outputs)
        _log_run_errors(errors)
        _log_latest_db_errors()
        return RunResponse(outputs=serialised, errors=errors)

    return app
