from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    frontend_origin: str = "http://localhost:5173"
    openai_api_key: str = ""
    llm_model: str = "gpt-4o-mini"
    stt_model: str = "whisper-1"
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-2"
    realtime_model: str = "gpt-realtime-2.1-mini"
    realtime_voice: str = "marin"
    realtime_transcription_model: str = "gpt-4o-mini-transcribe"
    realtime_session_rate_limit_per_minute: int = 10
    google_application_credentials: str = ""
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = ""
    elevenlabs_model_id: str = "eleven_multilingual_v2"
    # Optional ElevenLabs voice settings. When all are unset, no voice_settings
    # object is sent and the request payload is unchanged.
    elevenlabs_stability: float | None = Field(default=None, ge=0.0, le=1.0)
    elevenlabs_similarity_boost: float | None = Field(default=None, ge=0.0, le=1.0)
    elevenlabs_style: float | None = Field(default=None, ge=0.0, le=1.0)
    elevenlabs_use_speaker_boost: bool | None = None
    # ElevenLabs voice_settings.speed. Documented range 0.7-1.2 (default 1.0);
    # actual support is model-specific and requires live verification.
    elevenlabs_speed: float | None = Field(default=None, ge=0.7, le=1.2)
    # Google TTS AudioConfig.speaking_rate. Documented range 0.25-4.0
    # (default 1.0); audio behavior requires a live test.
    google_speaking_rate: float | None = Field(default=None, ge=0.25, le=4.0)
    stt_provider: str = "mock"
    llm_provider: str = "mock"
    tts_provider: str = "mock"
    simulate_tts_failure: bool = False
    simulate_tts_retry_with_mock: bool = False
    max_audio_bytes: int = 10 * 1024 * 1024
    max_audio_seconds: int = 120
    provider_timeout_seconds: float = 30.0

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
