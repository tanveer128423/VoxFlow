from pydantic import BaseModel, ConfigDict, Field, field_validator

# OpenAI Realtime GA voices. Kept conservative and explicit so the backend only
# ever forwards a known-supported voice to the Realtime API.
SUPPORTED_REALTIME_VOICES: tuple[str, ...] = (
    "alloy",
    "ash",
    "ballad",
    "cedar",
    "coral",
    "echo",
    "marin",
    "sage",
    "shimmer",
    "verse",
)

DEFAULT_VAD_THRESHOLD = 0.65
DEFAULT_VAD_PREFIX_PADDING_MS = 300
DEFAULT_VAD_SILENCE_DURATION_MS = 600
MAX_INSTRUCTIONS_LENGTH = 2000


class RealtimeTurnDetection(BaseModel):
    """Server VAD settings with bounds that match supported Realtime values."""

    model_config = ConfigDict(extra="forbid")

    threshold: float = Field(default=DEFAULT_VAD_THRESHOLD, ge=0.0, le=1.0)
    prefix_padding_ms: int = Field(default=DEFAULT_VAD_PREFIX_PADDING_MS, ge=0, le=2000)
    silence_duration_ms: int = Field(
        default=DEFAULT_VAD_SILENCE_DURATION_MS, ge=0, le=5000
    )


class RealtimeSessionRequest(BaseModel):
    """Optional per-session configuration submitted by the frontend."""

    model_config = ConfigDict(extra="forbid")

    voice: str | None = None
    instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS_LENGTH)
    turn_detection: RealtimeTurnDetection | None = None

    @field_validator("voice")
    @classmethod
    def _voice_must_be_supported(cls, value: str | None) -> str | None:
        if value is not None and value not in SUPPORTED_REALTIME_VOICES:
            raise ValueError("Unsupported voice selection.")
        return value

    def validated_voice(self, default_voice: str) -> str:
        voice = self.voice if self.voice is not None else default_voice
        if voice not in SUPPORTED_REALTIME_VOICES:
            raise ValueError("Unsupported voice selection.")
        return voice

    def effective_instructions(self) -> str | None:
        if self.instructions is None:
            return None
        instructions = self.instructions.strip()
        return instructions or None

    def effective_turn_detection(self) -> RealtimeTurnDetection:
        return self.turn_detection or RealtimeTurnDetection()


class TranscriptionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transcript: str


class VoiceTurnTimings(BaseModel):
    """Wall-clock durations around each fallback provider call, in milliseconds.

    These measure the time the backend spends awaiting each provider call
    (including network/transport), not the provider's pure compute time.
    """

    stt_ms: int | None = None
    llm_ms: int | None = None
    tts_ms: int | None = None
    total_ms: int | None = None


class VoiceTurnResponse(TranscriptionResponse):
    response: str
    audio_base64: str | None = None
    audio_content_type: str | None = None
    tts_error: str | None = None
    timings: VoiceTurnTimings | None = None


class SynthesizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str


class SynthesizeResponse(BaseModel):
    audio_base64: str
    audio_content_type: str


class RealtimeSessionResponse(BaseModel):
    client_secret: str
    model: str
    voice: str
    transcription_model: str
    instructions: str | None = None
    turn_detection: RealtimeTurnDetection


class VoicePreviewRequest(BaseModel):
    """Request a short audio sample for a supported Realtime voice."""

    model_config = ConfigDict(extra="forbid")

    voice: str

    @field_validator("voice")
    @classmethod
    def _voice_must_be_supported(cls, value: str) -> str:
        if value not in SUPPORTED_REALTIME_VOICES:
            raise ValueError("Unsupported voice selection.")
        return value


class VoicePreviewResponse(BaseModel):
    voice: str
    audio_base64: str
    audio_content_type: str


class RealtimeVoiceOptionsResponse(BaseModel):
    """Supported Realtime voices and defaults, as a single source of truth."""

    voices: list[str]
    default_voice: str
    default_turn_detection: RealtimeTurnDetection


class FallbackTtsInfoResponse(BaseModel):
    """Active fallback TTS provider and its supported speed range."""

    provider: str
    speed_supported: bool
    speed_min: float | None = None
    speed_max: float | None = None
    speed_default: float | None = None
