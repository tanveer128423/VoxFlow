from dataclasses import dataclass

from fastapi import UploadFile

from app.config import Settings
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


def create_llm_provider(settings: Settings):
    if settings.llm_provider == "openai":
        return OpenAILanguageModel(
            api_key=settings.openai_api_key,
            timeout_seconds=settings.provider_timeout_seconds,
        )
    return MockLanguageModel()


def create_tts_provider(
    settings: Settings,
    include_simulated_failure: bool = True,
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
        )
    if settings.tts_provider == "google":
        return GoogleTextToSpeech(
            credentials_path=settings.google_application_credentials
        )
    return MockTextToSpeech()


async def process_voice_turn(
    audio: UploadFile,
    settings: Settings,
    stt_provider: SpeechToTextProvider | None = None,
    tts_provider=None,
) -> VoiceTurnResult:
    transcript = await transcribe_upload(
        upload=audio,
        settings=settings,
        provider=stt_provider or create_stt_provider(settings),
    )
    if not transcript.strip():
        raise VoicePipelineError("No speech was detected in the recording.")

    response = await create_llm_provider(settings).generate(transcript)
    if not response.strip():
        raise VoicePipelineError("The language model returned an empty response.")

    try:
        audio_bytes, audio_content_type = await (
            tts_provider or create_tts_provider(settings)
        ).synthesize(response)
    except TTSError as exc:
        return VoiceTurnResult(
            transcript=transcript,
            response=response,
            audio_base64=None,
            audio_content_type=None,
            tts_error=str(exc),
        )

    return VoiceTurnResult(
        transcript=transcript,
        response=response,
        audio_base64=audio_as_base64(audio_bytes),
        audio_content_type=audio_content_type,
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
