import logging
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """Raised when the language model cannot produce a response."""


DEFAULT_SYSTEM_PROMPT = (
    "You are a concise, helpful voice assistant. "
    "Answer in plain language suitable for speech."
)


def resolve_system_prompt(instructions: str | None) -> str:
    """Use caller-supplied instructions when present, else the default prompt."""
    if instructions is not None:
        trimmed = instructions.strip()
        if trimmed:
            return trimmed
    return DEFAULT_SYSTEM_PROMPT


@dataclass
class MockLanguageModel:
    async def generate(
        self, transcript: str, instructions: str | None = None
    ) -> str:
        del instructions
        return f"I heard: {transcript}"


@dataclass
class OpenAILanguageModel:
    api_key: str
    timeout_seconds: float
    model: str = "gpt-4o-mini"
    transport: httpx.AsyncBaseTransport | None = None
    max_retries: int = 2

    async def generate(
        self, transcript: str, instructions: str | None = None
    ) -> str:
        if not self.api_key:
            raise LLMError("Language model is not configured.")

        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": resolve_system_prompt(instructions),
                },
                {"role": "user", "content": transcript},
            ],
            "max_tokens": 800,
            "temperature": 0.4,
        }
        headers = {
            "Authorization": "Bearer " + self.api_key,
            "Content-Type": "application/json",
        }

        started_at = time.perf_counter()
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds,
                transport=self.transport,
            ) as client:
                for attempt in range(self.max_retries + 1):
                    response = await client.post(
                        "https://api.openai.com/v1/chat/completions",
                        headers=headers,
                        json=payload,
                    )
                    if response.status_code not in (500, 502, 503, 504):
                        break
        except httpx.TimeoutException as exc:
            raise LLMError("The language model timed out.") from exc
        except httpx.HTTPError as exc:
            raise LLMError("The language model is unavailable.") from exc

        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        if response.status_code in (401, 403):
            raise LLMError("The language model authentication failed.")
        if response.status_code == 404:
            raise LLMError("The configured language model is unavailable.")
        if response.status_code == 429:
            raise LLMError("The language model is temporarily rate limited.")
        if response.status_code in (500, 502, 503, 504):
            raise LLMError("The language model is temporarily unavailable.")
        if response.is_error:
            raise LLMError("The language model failed.")

        try:
            payload = response.json()
            choice = payload["choices"][0]
            message = choice["message"]
            text = message["content"]
            finish_reason = choice.get("finish_reason", "unknown")
            usage = payload.get("usage", {})
            logger.info(
                "LLM completed: characters=%d output_tokens=%s finish_reason=%s duration_ms=%d",
                len(text),
                usage.get("completion_tokens", "unknown"),
                finish_reason,
                elapsed_ms,
            )
            if finish_reason == "length":
                raise LLMError(
                    "The language model response was truncated. Please try a shorter question."
                )
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError("The language model returned an invalid response.") from exc
        if not text.strip():
            raise LLMError("The language model returned an empty response.")
        return text.strip()
