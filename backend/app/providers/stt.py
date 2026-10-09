from dataclasses import dataclass
from typing import Protocol

import httpx


class STTError(RuntimeError):
    """Raised when speech transcription cannot be completed."""


class SpeechToTextProvider(Protocol):
    async def transcribe(
        self, audio: bytes, filename: str, content_type: str
    ) -> str: ...


@dataclass
class MockSpeechToText:
    async def transcribe(
        self, audio: bytes, filename: str, content_type: str
    ) -> str:
        del audio, filename, content_type
        return "This is a mock transcript. Configure an STT provider to transcribe real audio."


@dataclass
class OpenAISpeechToText:
    api_key: str
    timeout_seconds: float
    model: str = "whisper-1"
    endpoint: str = "https://api.openai.com/v1/audio/transcriptions"
    transport: httpx.AsyncBaseTransport | None = None

    async def transcribe(
        self, audio: bytes, filename: str, content_type: str
    ) -> str:
        if not self.api_key:
            raise STTError("Speech transcription is not configured.")

        headers = {"Authorization": "Bearer " + self.api_key}
        files = {"file": (filename, audio, content_type)}
        data = {"model": self.model, "response_format": "json"}

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds,
                transport=self.transport,
            ) as client:
                response = await client.post(
                    self.endpoint, headers=headers, files=files, data=data
                )
        except httpx.TimeoutException as exc:
            raise STTError("Speech transcription timed out.") from exc
        except httpx.HTTPError as exc:
            raise STTError("Speech transcription provider is unavailable.") from exc

        if response.status_code in (401, 403):
            raise STTError("Speech transcription authentication failed.")
        if response.status_code == 429:
            raise STTError("Speech transcription is temporarily rate limited.")
        if response.is_error:
            raise STTError("Speech transcription failed.")

        try:
            transcript = response.json()["text"]
        except (KeyError, TypeError, ValueError) as exc:
            raise STTError("Speech transcription returned an invalid response.") from exc
        if not isinstance(transcript, str):
            raise STTError("Speech transcription returned an invalid response.")
        return transcript.strip()
