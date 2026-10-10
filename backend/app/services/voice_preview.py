"""Short voice-preview samples for the Live Realtime voice dropdown.

The dropdown lists OpenAI *Realtime* voices. To let the user audition one, this
service asks the OpenAI speech endpoint (`/v1/audio/speech`) to synthesize a
short fixed phrase in the chosen voice and returns base64 audio. The OpenAI key
stays backend-only. Results are cached in-process keyed by (voice, model,
phrase) so each voice is synthesized at most once per process.

COMPATIBILITY NOTE: the newer Realtime voices ``marin`` and ``cedar`` may not be
available on the speech endpoint. When OpenAI rejects a voice, the service maps
the error to a clear VoicePreviewError and no (wrong) audio is ever returned.

This module performs NO network call during tests: callers inject an httpx
transport, and the route-level tests exercise only the validation/not-configured
paths.
"""

from __future__ import annotations

import base64

import httpx

from app.config import Settings

PREVIEW_MODEL = "gpt-4o-mini-tts"
PREVIEW_PHRASE_TEMPLATE = "Hi, this is a preview of the {voice} voice."
_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech"

# In-process cache: (voice, model, phrase) -> (audio_base64, content_type).
_preview_cache: dict[tuple[str, str, str], tuple[str, str]] = {}


class VoicePreviewError(RuntimeError):
    """Raised when a voice preview cannot be produced."""


def clear_voice_preview_cache() -> None:
    """Clear the in-process preview cache (used by tests)."""
    _preview_cache.clear()


async def synthesize_voice_preview(
    settings: Settings,
    voice: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str, str]:
    """Return (audio_base64, content_type) for a short sample of ``voice``.

    Raises VoicePreviewError when preview is not configured, the voice is
    unavailable on the speech endpoint, or the provider call fails.
    """
    if not settings.openai_api_key:
        raise VoicePreviewError("Voice preview is not configured.")

    phrase = PREVIEW_PHRASE_TEMPLATE.format(voice=voice)
    cache_key = (voice, PREVIEW_MODEL, phrase)
    cached = _preview_cache.get(cache_key)
    if cached is not None:
        return cached

    payload = {
        "model": PREVIEW_MODEL,
        "voice": voice,
        "input": phrase,
        "response_format": "mp3",
    }
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(
            timeout=settings.provider_timeout_seconds,
            transport=transport,
        ) as client:
            response = await client.post(
                _SPEECH_ENDPOINT, headers=headers, json=payload
            )
    except httpx.TimeoutException as exc:
        raise VoicePreviewError("Voice preview timed out.") from exc
    except httpx.HTTPError as exc:
        raise VoicePreviewError("Voice preview is unavailable.") from exc

    if response.status_code in (400, 404, 422):
        raise VoicePreviewError(
            "The selected voice is not available for preview."
        )
    if response.status_code in (401, 403):
        raise VoicePreviewError("Voice preview authentication failed.")
    if response.status_code == 429:
        raise VoicePreviewError("Voice preview is temporarily rate limited.")
    if response.status_code >= 500 or response.is_error:
        raise VoicePreviewError("Voice preview is temporarily unavailable.")

    audio_bytes = response.content
    if not audio_bytes:
        raise VoicePreviewError("Voice preview returned no audio.")

    result = (base64.b64encode(audio_bytes).decode("ascii"), "audio/mpeg")
    _preview_cache[cache_key] = result
    return result
