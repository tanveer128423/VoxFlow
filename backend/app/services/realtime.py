from dataclasses import dataclass

import httpx

from app.config import Settings


class RealtimeError(RuntimeError):
    """Raised when an ephemeral Realtime session cannot be created."""


@dataclass
class RealtimeSession:
    client_secret: str
    model: str
    transcription_model: str


async def create_realtime_session(
    settings: Settings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> RealtimeSession:
    if not settings.openai_api_key:
        raise RealtimeError("Realtime voice is not configured.")

    payload = {
        "session": {
            "type": "realtime",
            "model": settings.realtime_model,
            "audio": {
                "output": {"voice": settings.realtime_voice},
            },
        }
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
                "https://api.openai.com/v1/realtime/client_secrets",
                headers=headers,
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise RealtimeError("Realtime voice setup timed out.") from exc
    except httpx.HTTPError as exc:
        raise RealtimeError("Realtime voice is unavailable.") from exc

    if response.status_code in (401, 403):
        raise RealtimeError("Realtime voice authentication failed.")
    if response.status_code == 404:
        raise RealtimeError("The configured Realtime model is unavailable.")
    if response.status_code == 429:
        raise RealtimeError("Realtime voice is temporarily rate limited.")
    if response.status_code >= 500:
        raise RealtimeError("Realtime voice is temporarily unavailable.")
    if response.is_error:
        raise RealtimeError("Realtime voice setup failed.")

    try:
        client_secret = response.json()["value"]
    except (KeyError, TypeError, ValueError) as exc:
        raise RealtimeError("Realtime voice returned an invalid session.") from exc
    if not isinstance(client_secret, str) or not client_secret:
        raise RealtimeError("Realtime voice returned an invalid session.")

    return RealtimeSession(
        client_secret=client_secret,
        model=settings.realtime_model,
        transcription_model=settings.realtime_transcription_model,
    )
