import time
from dataclasses import dataclass

from fastapi import UploadFile

from app.config import Settings
from app.schemas.voice import VoiceTurnTimings
from app.providers.llm import MockLanguageModel, OpenAILanguageModel
from app.providers.stt import SpeechToTextProvider
from app.providers.tts import (
    ElevenLabsTextToSpeech,
    GoogleTextToSpeech,
    MockTextToSpeech,
    SimulatedFailureTextToSpeech,
    TTSError,
    audio_as_base64,
)
from app.services.transcription import create_stt_provider, transcribe_upload


class VoicePipelineError(RuntimeError):
    """Raised when a pipeline stage returns unusable output."""


@dataclass
class VoiceTurnResult:
    transcript: str
    response: str
    audio_base64: str | None
    audio_content_type: str | None
    tts_error: str | None = None
    timings: VoiceTurnTimings | None = None


def _elapsed_ms(started_at: float) -> int:
    return round((time.perf_counter() - started_at) * 1000)


def create_llm_provider(settings: Settings):
    if settings.llm_provider == "openai":
        return OpenAILanguageModel(
            api_key=settings.openai_api_key,
            timeout_seconds=settings.provider_timeout_seconds,
            model=settings.llm_model,
        )
    return MockLanguageModel()


# Documented speed ranges per fallback TTS provider. The backend is the
# authoritative source of bounds; the frontend never assumes one provider's
# range for another. Values follow each provider's published documentation.
FALLBACK_SPEED_BOUNDS: dict[str, dict[str, float]] = {
    "elevenlabs": {"min": 0.7, "max": 1.2, "default": 1.0},
    "google": {"min": 0.25, "max": 4.0, "default": 1.0},
}


class FallbackSpeedError(ValueError):
    """Raised when a per-request speed override is invalid for the provider."""


def fallback_tts_speed_info(settings: Settings) -> dict:
    """Report the active fallback TTS provider and its supported speed range."""
    bounds = FALLBACK_SPEED_BOUNDS.get(settings.tts_provider)
    if bounds is None:
        return {
            "provider": settings.tts_provider,
            "speed_supported": False,
            "speed_min": None,
            "speed_max": None,
            "speed_default": None,
        }
    return {
        "provider": settings.tts_provider,
        "speed_supported": True,
        "speed_min": bounds["min"],
        "speed_max": bounds["max"],
        "speed_default": bounds["default"],
    }


def validate_fallback_speed(
    settings: Settings, speed: float | None
) -> float | None:
    """Validate a per-request speed override against the active provider.

    Returns None when no override is supplied. Raises FallbackSpeedError when
    the provider cannot support speed or the value is out of range (never
    silently ignored).
    """
    if speed is None:
        return None
    bounds = FALLBACK_SPEED_BOUNDS.get(settings.tts_provider)
    if bounds is None:
        raise FallbackSpeedError(
            "The configured text-to-speech provider does not support speed."
        )
    if not bounds["min"] <= speed <= bounds["max"]:
        raise FallbackSpeedError(
            "The speed value is out of range for the configured provider."
        )
    return speed


def build_elevenlabs_voice_settings(
    settings: Settings, speed_override: float | None = None
) -> dict | None:
    """Assemble ElevenLabs voice_settings from configured fields only.

    Returns None when nothing is configured so the request payload stays
    byte-identical to the previous default behavior. A per-request
    speed_override takes precedence over the environment speed for this call.
    """
    voice_settings: dict = {}
    if settings.elevenlabs_stability is not None:
        voice_settings["stability"] = settings.elevenlabs_stability
    if settings.elevenlabs_similarity_boost is not None:
        voice_settings["similarity_boost"] = settings.elevenlabs_similarity_boost
    if settings.elevenlabs_style is not None:
        voice_settings["style"] = settings.elevenlabs_style
    if settings.elevenlabs_use_speaker_boost is not None:
        voice_settings["use_speaker_boost"] = settings.elevenlabs_use_speaker_boost
    if settings.elevenlabs_speed is not None:
        voice_settings["speed"] = settings.elevenlabs_speed
    if speed_override is not None:
        voice_settings["speed"] = speed_override
    return voice_settings or None


def create_tts_provider(
    settings: Settings,
    include_simulated_failure: bool = True,
    tts_speed: float | None = None,
):
    if (
        include_simulated_failure
        and
        settings.simulate_tts_failure
        and settings.app_env.lower() != "production"
    ):
        return SimulatedFailureTextToSpeech()
    if settings.tts_provider == "elevenlabs":
        return ElevenLabsTextToSpeech(
            api_key=settings.elevenlabs_api_key,
            voice_id=settings.elevenlabs_voice_id,
            model_id=settings.elevenlabs_model_id,
            timeout_seconds=settings.provider_timeout_seconds,
            voice_settings=build_elevenlabs_voice_settings(
                settings, speed_override=tts_speed
            ),
        )
    if settings.tts_provider == "google":
        return GoogleTextToSpeech(
            credentials_path=settings.google_application_credentials,
            speaking_rate=(
                tts_speed
                if tts_speed is not None
                else settings.google_speaking_rate
            ),
        )
    return MockTextToSpeech()


async def process_voice_turn(
    audio: UploadFile,
    settings: Settings,
    stt_provider: SpeechToTextProvider | None = None,
    tts_provider=None,
    instructions: str | None = None,
    tts_speed: float | None = None,
) -> VoiceTurnResult:
    turn_started_at = time.perf_counter()

    stt_started_at = time.perf_counter()
    transcript = await transcribe_upload(
        upload=audio,
        settings=settings,
        provider=stt_provider or create_stt_provider(settings),
    )
    stt_ms = _elapsed_ms(stt_started_at)
    if not transcript.strip():
        raise VoicePipelineError("No speech was detected in the recording.")

    llm_started_at = time.perf_counter()
    response = await create_llm_provider(settings).generate(
        transcript, instructions=instructions
    )
    llm_ms = _elapsed_ms(llm_started_at)
    if not response.strip():
        raise VoicePipelineError("The language model returned an empty response.")

    tts_started_at = time.perf_counter()
    try:
        audio_bytes, audio_content_type = await (
            tts_provider or create_tts_provider(settings, tts_speed=tts_speed)
        ).synthesize(response)
    except TTSError as exc:
        # Preserve the transcript and response; report the stages that did run
        # and leave tts_ms null since synthesis did not complete.
        return VoiceTurnResult(
            transcript=transcript,
            response=response,
            audio_base64=None,
            audio_content_type=None,
            tts_error=str(exc),
            timings=VoiceTurnTimings(
                stt_ms=stt_ms,
                llm_ms=llm_ms,
                tts_ms=None,
                total_ms=_elapsed_ms(turn_started_at),
            ),
        )
    tts_ms = _elapsed_ms(tts_started_at)

    return VoiceTurnResult(
        transcript=transcript,
        response=response,
        audio_base64=audio_as_base64(audio_bytes),
        audio_content_type=audio_content_type,
        timings=VoiceTurnTimings(
            stt_ms=stt_ms,
            llm_ms=llm_ms,
            tts_ms=tts_ms,
            total_ms=_elapsed_ms(turn_started_at),
        ),
    )


async def synthesize_response(
    text: str,
    settings: Settings,
) -> tuple[str, str]:
    if not text.strip():
        raise VoicePipelineError("The assistant response is empty.")

    if (
        settings.simulate_tts_retry_with_mock
        and settings.simulate_tts_failure
        and settings.app_env.lower() != "production"
    ):
        provider = MockTextToSpeech()
    else:
        provider = create_tts_provider(
            settings,
            include_simulated_failure=False,
        )
    audio_bytes, audio_content_type = await provider.synthesize(text)
    return audio_as_base64(audio_bytes), audio_content_type
