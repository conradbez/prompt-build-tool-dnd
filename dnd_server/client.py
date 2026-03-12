import os
from google import genai


def make_llm_call(api_key: str):
    """Return a llm_call function bound to the given Gemini API key."""
    def llm_call(prompt: str) -> str:
        c = genai.Client(api_key=api_key)
        return c.models.generate_content(
            model=os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
            contents=prompt,
        ).text
    return llm_call


def llm_call(prompt: str) -> str:
    """Default llm_call — reads GEMINI_API_KEY from environment."""
    return make_llm_call(os.environ["GEMINI_API_KEY"])(prompt)
