import json

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.providers.llm import OpenAILanguageModel
from app.providers.stt import (
    DeepgramSpeechToText,
    MockSpeechToText,
    OpenAISpeechToText,
    STTError,
)
from app.providers.tts import ElevenLabsTextToSpeech
from app.services.transcription import create_stt_provider
from app.services.voice_pipeline import (
    build_elevenlabs_voice_settings,
    create_llm_provider,
    create_tts_provider,
)


# --- Provider selection + configurable models --------------------------------


def test_stt_defaults_to_mock() -> None:
    # _env_file=None isolates the class defaults from any local .env overrides.
    assert isinstance(create_stt_provider(Settings(_env_file=None)), MockSpeechToText)


def test_openai_stt_uses_configured_model_with_default() -> None:
    default_provider = create_stt_provider(Settings(stt_provider="openai"))
    custom_provider = create_stt_provider(
        Settings(stt_provider="openai", stt_model="whisper-large-v3")
    )

    assert isinstance(default_provider, OpenAISpeechToText)
    assert default_provider.model == "whisper-1"
    assert custom_provider.model == "whisper-large-v3"


def test_openai_llm_uses_configured_model_with_default() -> None:
    default_provider = create_llm_provider(
        Settings(llm_provider="openai", openai_api_key="k")
    )
    custom_provider = create_llm_provider(
        Settings(llm_provider="openai", openai_api_key="k", llm_model="gpt-4o")
    )

    assert isinstance(default_provider, OpenAILanguageModel)
    assert default_provider.model == "gpt-4o-mini"
    assert custom_provider.model == "gpt-4o"


def test_deepgram_stt_is_selected_explicitly() -> None:
    provider = create_stt_provider(
        Settings(stt_provider="deepgram", deepgram_api_key="k")
    )

    assert isinstance(provider, DeepgramSpeechToText)
    assert provider.model == "nova-2"


# --- Deepgram request construction + parsing + errors ------------------------


@pytest.mark.anyio
async def test_deepgram_sends_expected_request_and_parses_transcript() -> None:
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(
            200,
            json={
                "results": {
                    "channels": [
                        {"alternatives": [{"transcript": "Hello from Deepgram"}]}
                    ]
                }
            },
        )

    provider = DeepgramSpeechToText(
        api_key="unit-test-key",
        timeout_seconds=5,
        model="nova-2",
        transport=httpx.MockTransport(handler),
    )

    transcript = await provider.transcribe(b"audio-bytes", "rec.webm", "audio/webm")

    assert transcript == "Hello from Deepgram"
    assert request_seen is not None
    assert request_seen.url.path == "/v1/listen"
    assert request_seen.headers["Authorization"] == "Token unit-test-key"
    assert request_seen.headers["content-type"] == "audio/webm"
    assert request_seen.url.params["model"] == "nova-2"
    assert request_seen.content == b"audio-bytes"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status_code", "message"),
    [
        (401, "authentication failed"),
        (403, "authentication failed"),
        (429, "temporarily rate limited"),
        (500, "failed"),
    ],
)
async def test_deepgram_maps_http_errors(status_code: int, message: str) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(status_code, content=b"provider details")

    provider = DeepgramSpeechToText(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(STTError, match=message):
        await provider.transcribe(b"audio", "rec.webm", "audio/webm")


@pytest.mark.anyio
async def test_deepgram_maps_timeout() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        raise httpx.ReadTimeout("simulated timeout")

    provider = DeepgramSpeechToText(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(STTError, match="timed out"):
        await provider.transcribe(b"audio", "rec.webm", "audio/webm")


@pytest.mark.anyio
async def test_deepgram_rejects_malformed_response() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(200, json={"unexpected": "shape"})

    provider = DeepgramSpeechToText(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(STTError, match="invalid response"):
        await provider.transcribe(b"audio", "rec.webm", "audio/webm")


@pytest.mark.anyio
async def test_deepgram_requires_api_key() -> None:
    provider = DeepgramSpeechToText(api_key="", timeout_seconds=5)

    with pytest.raises(STTError, match="not configured"):
        await provider.transcribe(b"audio", "rec.webm", "audio/webm")


# --- ElevenLabs optional voice_settings --------------------------------------


def test_voice_settings_absent_by_default() -> None:
    assert build_elevenlabs_voice_settings(Settings()) is None


def test_voice_settings_built_from_configured_fields_only() -> None:
    settings = Settings(
        elevenlabs_stability=0.5,
        elevenlabs_use_speaker_boost=True,
    )

    assert build_elevenlabs_voice_settings(settings) == {
        "stability": 0.5,
        "use_speaker_boost": True,
    }


@pytest.mark.anyio
async def test_elevenlabs_payload_omits_voice_settings_when_absent() -> None:
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(
            200, headers={"content-type": "audio/mpeg"}, content=b"ID3audio"
        )

    provider = ElevenLabsTextToSpeech(
        api_key="k",
        voice_id="v",
        model_id="eleven_multilingual_v2",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    await provider.synthesize("Hello")

    assert request_seen is not None
    assert json.loads(request_seen.content) == {
        "text": "Hello",
        "model_id": "eleven_multilingual_v2",
    }


@pytest.mark.anyio
async def test_elevenlabs_payload_includes_voice_settings_when_present() -> None:
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(
            200, headers={"content-type": "audio/mpeg"}, content=b"ID3audio"
        )

    provider = ElevenLabsTextToSpeech(
        api_key="k",
        voice_id="v",
        model_id="eleven_multilingual_v2",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
        voice_settings={"stability": 0.5, "similarity_boost": 0.75},
    )

    await provider.synthesize("Hello")

    assert request_seen is not None
    assert json.loads(request_seen.content) == {
        "text": "Hello",
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }


def test_elevenlabs_default_model_and_voice_unchanged() -> None:
    settings = Settings(
        tts_provider="elevenlabs",
        elevenlabs_api_key="k",
        elevenlabs_voice_id="v",
    )
    provider = create_tts_provider(settings)

    assert isinstance(provider, ElevenLabsTextToSpeech)
    assert provider.model_id == "eleven_multilingual_v2"
    assert provider.voice_settings is None


# --- Configuration validation ------------------------------------------------


@pytest.mark.parametrize(
    "field",
    [
        "elevenlabs_stability",
        "elevenlabs_similarity_boost",
        "elevenlabs_style",
    ],
)
def test_voice_setting_ranges_are_validated(field: str) -> None:
    with pytest.raises(ValidationError):
        Settings(**{field: 1.5})
    with pytest.raises(ValidationError):
        Settings(**{field: -0.1})
