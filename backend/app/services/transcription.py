from fastapi import UploadFile

from app.config import Settings
from app.providers.stt import (
    GroqSpeechToText,
    MockSpeechToText,
    SpeechToTextProvider,
)

ALLOWED_AUDIO_TYPES = {
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/wave",
    "audio/x-wav",
}


class AudioValidationError(ValueError):
    """Raised when an uploaded recording is not acceptable."""


def normalize_audio_content_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def create_stt_provider(settings: Settings) -> SpeechToTextProvider:
    if settings.stt_provider == "groq":
        return GroqSpeechToText(
            api_key=settings.groq_api_key,
            timeout_seconds=settings.provider_timeout_seconds,
        )
    return MockSpeechToText()


async def transcribe_upload(
    upload: UploadFile,
    settings: Settings,
    provider: SpeechToTextProvider,
) -> str:
    content_type = normalize_audio_content_type(upload.content_type or "")
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise AudioValidationError("Unsupported audio format.")

    audio = await upload.read(settings.max_audio_bytes + 1)
    if not audio:
        raise AudioValidationError("The audio recording is empty.")
    if len(audio) > settings.max_audio_bytes:
        raise AudioValidationError("The audio recording is too large.")

    return await provider.transcribe(
        audio=audio,
        filename=upload.filename or "recording.webm",
        content_type=content_type,
    )
