import base64
import os


def _env_key_name(provider: str) -> str:
    return {
        "gemini": "GEMINI_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }[provider]


def _detect_mime(data: bytes) -> str:
    if data[:4] == b"%PDF":
        return "application/pdf"
    try:
        data.decode("utf-8")
        return "text/plain"
    except UnicodeDecodeError:
        return "application/octet-stream"


def _read_files(files) -> list[tuple[bytes, str]]:
    """Read each file handle and return (bytes, mime_type) pairs."""
    result = []
    for f in (files or []):
        data = f.read()
        result.append((data, _detect_mime(data)))
    return result


def make_llm_call(api_key: str | None = None, provider: str = "gemini"):
    """Return a llm_call function bound to the given provider and API key."""
    def llm_call(prompt: str, files=None, config=None) -> str:
        print(f"[llm_call] prompt sent to {provider}:\n{prompt[:500]}\n")
        print(f"[llm_call] files: {files}")
        resolved_api_key = api_key or os.environ[_env_key_name(provider)]
        file_data = _read_files(files)

        if provider == "gemini":
            from google import genai
            from google.genai import types

            parts = []
            for data, mime in file_data:
                parts.append(types.Part.from_bytes(data=data, mime_type=mime))
            parts.append(prompt)

            client = genai.Client(api_key=resolved_api_key)
            return client.models.generate_content(
                model=os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
                contents=parts,
            ).text

        if provider == "openai":
            import io
            import openai

            client = openai.OpenAI(api_key=resolved_api_key)
            model = os.environ.get("OPENAI_MODEL", "gpt-5-mini")
            messages = [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
            uploaded_ids = []
            for data, mime in file_data:
                f = client.files.create(file=("document.pdf", io.BytesIO(data), mime), purpose="user_data")
                uploaded_ids.append(f.id)
                messages[0]["content"].append({"type": "file", "file": {"file_id": f.id}})
            try:
                response = client.chat.completions.create(model=model, messages=messages)
            finally:
                for fid in uploaded_ids:
                    try: client.files.delete(fid)
                    except Exception: pass
            return response.choices[0].message.content

        if provider == "anthropic":
            import anthropic

            content = []
            for data, mime in file_data:
                b64 = base64.standard_b64encode(data).decode()
                if mime == "application/pdf":
                    content.append({
                        "type": "document",
                        "source": {"type": "base64", "media_type": mime, "data": b64},
                    })
                else:
                    content.append({"type": "text", "text": data.decode("utf-8", errors="replace")})
            content.append({"type": "text", "text": prompt})

            client = anthropic.Anthropic(api_key=resolved_api_key)
            message = client.messages.create(
                model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
                max_tokens=8096,
                messages=[{"role": "user", "content": content}],
            )
            return "".join(
                block.text for block in message.content if getattr(block, "type", None) == "text"
            )

        raise ValueError(f"Unsupported provider: {provider}")

    return llm_call


def llm_call(prompt: str, provider: str = "gemini") -> str:
    """Default llm_call — reads the selected provider API key from environment."""
    return make_llm_call(provider=provider)(prompt)
