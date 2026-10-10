import asyncio
import base64
import io
import logging
import math
import time
import wave
from dataclasses import dataclass
import httpx

logger = logging.getLogger(__name__)

class TTSError(RuntimeError):
    """Raised when speech synthesis cannot be completed."""


def _validate_audio_payload(audio: bytes, content_type: str) -> None:
    if not audio:
        raise TTSError("Text-to-speech returned empty audio.")
    if content_type == "audio/mpeg":
        has_id3_header = audio.startswith(b"ID3")
        has_mpeg_frame = len(audio) >= 2 and audio[0] == 0xFF and audio[1] & 0xE0 == 0xE0
        if not (has_id3_header or has_mpeg_frame):
            raise TTSError("Text-to-speech returned invalid MP3 audio.")


@dataclass
class SimulatedFailureTextToSpeech:
    async def synthesize(self, text: str) -> tuple[bytes, str]:
        del text
        raise TTSError("Simulated text-to-speech failure.")


@dataclass
class MockTextToSpeech:
    async def synthesize(self, text: str) -> tuple[bytes, str]:
        del text
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            frames = bytearray()
            for index in range(8000):
                sample = int(8000 * math.sin(2 * math.pi * 440 * index / 8000))
                frames.extend(sample.to_bytes(2, byteorder="little", signed=True))
            output.writeframes(frames)
        return buffer.getvalue(), "audio/wav"


def google_audio_config_kwargs(speaking_rate: float | None) -> dict:
    """Optional AudioConfig kwargs. Empty when unset so the request is unchanged."""
    if speaking_rate is None:
        return {}
    return {"speaking_rate": speaking_rate}


@dataclass
class GoogleTextToSpeech:
    credentials_path: str
    speaking_rate: float | None = None

    async def synthesize(self, text: str) -> tuple[bytes, str]:
        if not self.credentials_path:
            raise TTSError("Text-to-speech is not configured.")

        try:
            from google.cloud import texttospeech
            from google.api_core.exceptions import GoogleAPICallError
            from google.auth.exceptions import GoogleAuthError
        except ImportError as exc:
            raise TTSError("Text-to-speech dependencies are not installed.") from exc

        def request() -> bytes:
            client = texttospeech.TextToSpeechClient.from_service_account_file(
                self.credentials_path
            )
            response = client.synthesize_speech(
                input=texttospeech.SynthesisInput(text=text),
                voice=texttospeech.VoiceSelectionParams(
                    language_code="en-US", name="en-US-Neural2-F"
                ),
                audio_config=texttospeech.AudioConfig(
                    audio_encoding=texttospeech.AudioEncoding.MP3,
                    **google_audio_config_kwargs(self.speaking_rate),
                ),
            )
            return response.audio_content

        try:
            return await asyncio.to_thread(request), "audio/mpeg"
        except (GoogleAPICallError, GoogleAuthError, OSError, ValueError) as exc:
            raise TTSError("Text-to-speech failed.") from exc


@dataclass
class ElevenLabsTextToSpeech:
    api_key: str
    voice_id: str
    model_id: str
    timeout_seconds: float
    transport: httpx.AsyncBaseTransport | None = None
    endpoint: str = "https://api.elevenlabs.io/v1/text-to-speech"
    voice_settings: dict | None = None

    async def synthesize(self, text: str) -> tuple[bytes, str]:
        if not self.api_key or not self.voice_id:
            raise TTSError("Text-to-speech is not configured.")

        started_at = time.perf_counter()
        logger.info("TTS started: characters=%d", len(text))
        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": self.api_key,
        }
        payload: dict = {"text": text, "model_id": self.model_id}
        if self.voice_settings:
            payload["voice_settings"] = self.voice_settings
        url = f"{self.endpoint}/{self.voice_id}"

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds, transport=self.transport
            ) as client:
                response = await client.post(url, headers=headers, json=payload)
        except httpx.TimeoutException as exc:
            raise TTSError("Text-to-speech timed out.") from exc
        except httpx.HTTPError as exc:
            raise TTSError("Text-to-speech provider is unavailable.") from exc

        if response.status_code in (401, 403):
            raise TTSError("Text-to-speech authentication failed.")
        if response.status_code == 429:
            raise TTSError("Text-to-speech is temporarily rate limited.")
        if response.is_error:
            raise TTSError("Text-to-speech failed.")
        content_type = response.headers.get("content-type", "").split(";", 1)[0]
        if content_type not in {"audio/mpeg", "audio/mp3"}:
            raise TTSError("Text-to-speech returned an invalid audio response.")
        _validate_audio_payload(response.content, "audio/mpeg")
        logger.info(
            "TTS completed: characters=%d audio_bytes=%d duration_ms=%d",
            len(text),
            len(response.content),
            round((time.perf_counter() - started_at) * 1000),
        )
        return response.content, "audio/mpeg"


def audio_as_base64(audio: bytes) -> str:
    return base64.b64encode(audio).decode("ascii")
