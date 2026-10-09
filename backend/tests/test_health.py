import io
import json
import base64
import wave

import httpx
import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient

from app.main import app
from app.config import Settings, get_settings
from app.providers.stt import GroqSpeechToText, MockSpeechToText
from app.providers.llm import GeminiLanguageModel, LLMError
from app.providers.tts import (
    ElevenLabsTextToSpeech,
    MockTextToSpeech,
    SimulatedFailureTextToSpeech,
    TTSError,
)
from app.services.transcription import create_stt_provider
from app.services.voice_pipeline import create_tts_provider


@pytest.fixture(autouse=True)
def use_mock_app_providers():
    app.dependency_overrides[get_settings] = lambda: Settings(
        stt_provider="mock",
        llm_provider="mock",
        tts_provider="mock",
        simulate_tts_failure=False,
    )
    yield
    app.dependency_overrides.clear()


def test_health_endpoint() -> None:
    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_transcribe_uses_mock_provider_by_default() -> None:
    response = TestClient(app).post(
        "/api/transcribe",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 200
    assert response.json()["transcript"].startswith("This is a mock transcript")


def test_transcribe_accepts_webm_opus_content_type() -> None:
    response = TestClient(app).post(
        "/api/transcribe",
        files={
            "audio": (
                "recording.webm",
                b"fake audio",
                "audio/webm;codecs=opus",
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["transcript"].startswith("This is a mock transcript")


def test_transcribe_rejects_unsupported_audio_type() -> None:
    response = TestClient(app).post(
        "/api/transcribe",
        files={"audio": ("recording.txt", b"not audio", "text/plain")},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Unsupported audio format."}


def test_transcribe_rejects_empty_audio() -> None:
    response = TestClient(app).post(
        "/api/transcribe",
        files={"audio": ("recording.webm", b"", "audio/webm")},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "The audio recording is empty."}


def test_groq_provider_is_selected_explicitly() -> None:
    provider = create_stt_provider(Settings(stt_provider="groq"))

    assert provider.__class__.__name__ == "GroqSpeechToText"


@pytest.mark.anyio
async def test_groq_uses_bearer_api_key_without_real_request() -> None:
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(200, json={"text": "Transcribed audio"})

    provider = GroqSpeechToText(
        api_key="unit-test-groq-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    assert await provider.transcribe(b"audio", "recording.webm", "audio/webm") == (
        "Transcribed audio"
    )
    assert request_seen is not None
    assert request_seen.headers["Authorization"] == "Bearer unit-test-groq-key"


def test_gemini_uses_configured_model() -> None:
    provider = GeminiLanguageModel(api_key="test-key", timeout_seconds=5)

    assert provider.model == "gemini-3.8-flash"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status_code", "message"),
    [
        (401, "authentication failed"),
        (404, "configured language model is unavailable"),
        (429, "temporarily rate limited"),
        (503, "temporarily unavailable"),
    ],
)
async def test_gemini_classifies_upstream_status_without_details(
    status_code: int, message: str
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(status_code, content=b"secret provider details")

    provider = GeminiLanguageModel(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(LLMError, match=message):
        await provider.generate("Hello")


@pytest.mark.anyio
async def test_gemini_retries_transient_unavailable_response() -> None:
    attempts = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        del request
        attempts += 1
        if attempts < 2:
            return httpx.Response(503)
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": "Recovered response"}]}}
                ]
            },
        )

    provider = GeminiLanguageModel(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
        max_retries=1,
    )

    assert await provider.generate("Hello") == "Recovered response"
    assert attempts == 2


@pytest.mark.anyio
async def test_gemini_preserves_all_response_parts_and_long_text() -> None:
    long_text = " ".join(["A detailed explanation continues."] * 80)

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["generationConfig"]["maxOutputTokens"] == 800
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"text": long_text[:500]},
                                {"text": long_text[500:]},
                            ]
                        },
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {"candidatesTokenCount": 640},
            },
        )

    provider = GeminiLanguageModel(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    assert await provider.generate("Explain the pipeline in detail.") == long_text


@pytest.mark.anyio
async def test_gemini_rejects_truncated_output_explicitly() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {"parts": [{"text": "Incomplete answer"}]},
                        "finishReason": "MAX_TOKENS",
                    }
                ],
                "usageMetadata": {"candidatesTokenCount": 800},
            },
        )

    provider = GeminiLanguageModel(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(LLMError, match="response was truncated"):
        await provider.generate("Explain the pipeline in detail.")


def test_voice_turn_uses_all_mock_adapters() -> None:
    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["transcript"].startswith("This is a mock transcript")
    assert body["response"].startswith("I heard:")
    assert body["audio_content_type"] == "audio/wav"
    assert body["audio_base64"]


@pytest.mark.anyio
async def test_mock_tts_generates_valid_pcm_wav() -> None:
    audio, content_type = await MockTextToSpeech().synthesize("Hello")

    assert content_type == "audio/wav"
    assert audio[:4] == b"RIFF"
    assert audio[8:12] == b"WAVE"
    with wave.open(io.BytesIO(audio), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 8000
        assert wav.getnframes() > 0
        frames = wav.readframes(wav.getnframes())
        assert len(frames) > 0
        assert any(frame_byte != 0 for frame_byte in frames)


def test_synthesize_response_contains_exact_valid_wav_bytes() -> None:
    response = TestClient(app).post(
        "/api/synthesize",
        json={"text": "Retry this existing assistant response."},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["audio_content_type"] == "audio/wav"
    audio = base64.b64decode(body["audio_base64"], validate=True)
    with wave.open(io.BytesIO(audio), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 8000
        assert wav.getnframes() == 8000
        frames = wav.readframes(wav.getnframes())
        assert len(frames) == 16000
        assert any(frame_byte != 0 for frame_byte in frames)


def test_elevenlabs_provider_is_selected_explicitly() -> None:
    provider = create_tts_provider(
        Settings(
            simulate_tts_failure=False,
            tts_provider="elevenlabs",
            elevenlabs_api_key="test-key",
            elevenlabs_voice_id="test-voice",
        )
    )

    assert isinstance(provider, ElevenLabsTextToSpeech)


def test_simulated_tts_failure_is_selected_only_outside_production() -> None:
    provider = create_tts_provider(
        Settings(
            app_env="development",
            simulate_tts_failure=True,
            tts_provider="elevenlabs",
        )
    )
    production_provider = create_tts_provider(
        Settings(
            app_env="production",
            simulate_tts_failure=True,
            tts_provider="mock",
        )
    )

    assert isinstance(provider, SimulatedFailureTextToSpeech)
    assert production_provider.__class__.__name__ == "MockTextToSpeech"


@pytest.mark.anyio
async def test_elevenlabs_sends_supported_request_and_returns_mp3() -> None:
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(
            200,
            headers={"content-type": "audio/mpeg"},
            content=b"ID3fake-mp3",
        )

    provider = ElevenLabsTextToSpeech(
        api_key="test-key",
        voice_id="test-voice",
        model_id="eleven_multilingual_v2",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    audio, content_type = await provider.synthesize("Hello")

    assert request_seen is not None
    assert request_seen.url.path.endswith("/test-voice")
    assert request_seen.headers["xi-api-key"] == "test-key"
    assert request_seen.headers["accept"] == "audio/mpeg"
    assert json.loads(request_seen.content) == {
        "text": "Hello",
        "model_id": "eleven_multilingual_v2",
    }
    assert audio == b"ID3fake-mp3"
    assert content_type == "audio/mpeg"


@pytest.mark.anyio
async def test_elevenlabs_receives_complete_long_response() -> None:
    request_seen: httpx.Request | None = None
    long_text = " ".join(["Continue the explanation."] * 250)

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(
            200,
            headers={"content-type": "audio/mpeg"},
            content=b"ID3long-mp3",
        )

    provider = ElevenLabsTextToSpeech(
        api_key="test-key",
        voice_id="test-voice",
        model_id="eleven_multilingual_v2",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    await provider.synthesize(long_text)

    assert request_seen is not None
    assert json.loads(request_seen.content)["text"] == long_text


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status_code", "message"),
    [
        (401, "Text-to-speech authentication failed."),
        (429, "Text-to-speech is temporarily rate limited."),
    ],
)
async def test_elevenlabs_maps_provider_errors(
    status_code: int, message: str
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(status_code, content=b"provider details")

    provider = ElevenLabsTextToSpeech(
        api_key="test-key",
        voice_id="test-voice",
        model_id="test-model",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(TTSError, match=message):
        await provider.synthesize("Hello")


@pytest.mark.anyio
async def test_elevenlabs_rejects_non_audio_success_response() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            content=b'{"error":"not audio"}',
        )

    provider = ElevenLabsTextToSpeech(
        api_key="test-key",
        voice_id="test-voice",
        model_id="test-model",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(TTSError, match="invalid audio response"):
        await provider.synthesize("Hello")


@pytest.mark.anyio
async def test_elevenlabs_rejects_invalid_mp3_payload() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            headers={"content-type": "audio/mpeg"},
            content=b"not-an-mp3",
        )

    provider = ElevenLabsTextToSpeech(
        api_key="test-key",
        voice_id="test-voice",
        model_id="test-model",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(TTSError, match="invalid MP3"):
        await provider.synthesize("Hello")


@pytest.mark.anyio
async def test_elevenlabs_maps_timeout_without_provider_details() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        raise httpx.ReadTimeout("simulated timeout")

    provider = ElevenLabsTextToSpeech(
        api_key="unit-test-key",
        voice_id="test-voice",
        model_id="test-model",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(TTSError, match="timed out"):
        await provider.synthesize("Hello")


def test_synthesize_route_uses_existing_text_only() -> None:
    response = TestClient(app).post(
        "/api/synthesize",
        json={"text": "Use the existing assistant response."},
    )

    assert response.status_code == 200
    assert response.json()["audio_content_type"] == "audio/wav"
    assert response.json()["audio_base64"]


def test_simulated_voice_failure_then_synthesize_retry_succeeds() -> None:
    settings = Settings(
        app_env="development",
        simulate_tts_failure=True,
        simulate_tts_retry_with_mock=True,
        stt_provider="mock",
        llm_provider="mock",
        tts_provider="elevenlabs",
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        voice_turn = TestClient(app).post(
            "/api/voice-turn",
            files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        )
        retry = TestClient(app).post(
            "/api/synthesize",
            json={"text": voice_turn.json()["response"]},
        )
    finally:
        app.dependency_overrides.clear()

    assert voice_turn.status_code == 200
    assert voice_turn.json()["audio_base64"] is None
    assert voice_turn.json()["response"].startswith("I heard:")
    assert retry.status_code == 200
    assert retry.json()["audio_content_type"] == "audio/wav"
    assert retry.json()["audio_base64"]


@pytest.mark.anyio
async def test_voice_turn_keeps_text_when_tts_fails() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(503)

    settings = Settings(
        llm_provider="mock",
        tts_provider="elevenlabs",
        elevenlabs_api_key="test-key",
        elevenlabs_voice_id="test-voice",
    )
    provider = ElevenLabsTextToSpeech(
        api_key="test-key",
        voice_id="test-voice",
        model_id="test-model",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    from app.services.voice_pipeline import process_voice_turn

    result = await process_voice_turn(
        audio=UploadFile(
            filename="recording.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        ),
        settings=settings,
        stt_provider=MockSpeechToText(),
        tts_provider=provider,
    )

    assert result.response.startswith("I heard:")
    assert result.audio_base64 is None
    assert result.tts_error == "Text-to-speech failed."


def test_simulated_tts_failure_preserves_voice_turn_text() -> None:
    settings = Settings(
        app_env="development",
        simulate_tts_failure=True,
        stt_provider="mock",
        llm_provider="mock",
        tts_provider="elevenlabs",
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        response = TestClient(app).post(
            "/api/voice-turn",
            files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["transcript"].startswith("This is a mock transcript")
    assert body["response"].startswith("I heard:")
    assert body["audio_base64"] is None
    assert body["audio_content_type"] is None
    assert body["tts_error"] == "Simulated text-to-speech failure."


def test_voice_turn_returns_stage_specific_llm_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class TimeoutLanguageModel:
        async def generate(self, transcript: str) -> str:
            del transcript
            raise LLMError("The language model timed out.")

    from app.services import voice_pipeline

    monkeypatch.setattr(
        voice_pipeline,
        "create_llm_provider",
        lambda settings: TimeoutLanguageModel(),
    )
    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "The language model timed out."}


def test_synthesize_route_is_the_only_operation_for_retry() -> None:
    settings = Settings(
        app_env="development",
        simulate_tts_failure=True,
        simulate_tts_retry_with_mock=True,
        stt_provider="groq",
        llm_provider="gemini",
        tts_provider="elevenlabs",
    )
    app.dependency_overrides[get_settings] = lambda: settings

    try:
        response = TestClient(app).post(
            "/api/synthesize",
            json={"text": "Retry this existing assistant response."},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["audio_content_type"] == "audio/wav"
    assert response.json()["audio_base64"]
