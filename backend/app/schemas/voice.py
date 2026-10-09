from pydantic import BaseModel, ConfigDict


class TranscriptionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transcript: str


class VoiceTurnResponse(TranscriptionResponse):
    response: str
    audio_base64: str | None = None
    audio_content_type: str | None = None
    tts_error: str | None = None


class SynthesizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str


class SynthesizeResponse(BaseModel):
    audio_base64: str
    audio_content_type: str
