import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """Raised when the language model cannot produce a response."""


@dataclass
class MockLanguageModel:
    async def generate(self, transcript: str) -> str:
        return f"I heard: {transcript}"


@dataclass
class GeminiLanguageModel:
    api_key: str
    timeout_seconds: float
    model: str = "gemini-3.8-flash"
    transport: httpx.AsyncBaseTransport | None = None
    max_retries: int = 2

    async def generate(self, transcript: str) -> str:
        if not self.api_key:
            raise LLMError("Language model is not configured.")

        endpoint = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent"
        )
        payload = {
            "contents": [{"parts": [{"text": transcript}]}],
            "systemInstruction": {
                "parts": [
                    {
                        "text": (
                            "You are a concise, helpful voice assistant. "
                            "Answer in plain language suitable for speech."
                        )
                    }
                ]
            },
            "generationConfig": {"maxOutputTokens": 800, "temperature": 0.4},
        }

        started_at = time.perf_counter()
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds,
                transport=self.transport,
            ) as client:
                for attempt in range(self.max_retries + 1):
                    response = await client.post(
                        endpoint,
                        params={"key": self.api_key},
                        json=payload,
                    )
                    if response.status_code not in (500, 502, 503, 504):
                        break
                    if attempt < self.max_retries:
                        await asyncio.sleep(0.5 * (attempt + 1))
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
            candidate = payload["candidates"][0]
            parts = candidate["content"]["parts"]
            text = "".join(
                part["text"] for part in parts if isinstance(part, dict) and "text" in part
            )
            finish_reason = candidate.get("finishReason", "UNKNOWN")
            usage = payload.get("usageMetadata", {})
            logger.info(
                "LLM completed: characters=%d output_tokens=%s finish_reason=%s duration_ms=%d",
                len(text),
                usage.get("candidatesTokenCount", "unknown"),
                finish_reason,
                elapsed_ms,
            )
            if finish_reason == "MAX_TOKENS":
                raise LLMError(
                    "The language model response was truncated. Please try a shorter question."
                )
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError("The language model returned an invalid response.") from exc
        if not text.strip():
            raise LLMError("The language model returned an empty response.")
        return text.strip()
