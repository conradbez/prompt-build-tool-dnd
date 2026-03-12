import os


def _env_key_name(provider: str) -> str:
    return {
        "gemini": "GEMINI_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }[provider]


def make_llm_call(api_key: str | None = None, provider: str = "gemini"):
    """Return a llm_call function bound to the given provider and API key."""
    def llm_call(prompt: str) -> str:
        resolved_api_key = api_key or os.environ[_env_key_name(provider)]

        if provider == "gemini":
            from google import genai

            client = genai.Client(api_key=resolved_api_key)
            return client.models.generate_content(
                model=os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
                contents=prompt,
            ).text

        if provider == "openai":
            from openai import OpenAI

            client = OpenAI(api_key=resolved_api_key)
            response = client.responses.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                input=prompt,
            )
            return response.output_text

        if provider == "anthropic":
            import anthropic

            client = anthropic.Anthropic(api_key=resolved_api_key)
            message = client.messages.create(
                model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
                max_tokens=8096,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(
                block.text for block in message.content if getattr(block, "type", None) == "text"
            )

        raise ValueError(f"Unsupported provider: {provider}")

    return llm_call


def llm_call(prompt: str, provider: str = "gemini") -> str:
    """Default llm_call — reads the selected provider API key from environment."""
    return make_llm_call(provider=provider)(prompt)
