import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.providers.tts import ElevenLabsTextToSpeech, GoogleTextToSpeech
from app.services.voice_pipeline import (
    FallbackSpeedError,
    build_elevenlabs_voice_settings,
    create_tts_provider,
    fallback_tts_speed_info,
    validate_fallback_speed,
)


@pytest.fixture(autouse=True)
def clear_overrides():
    yield
    app.dependency_overrides.clear()


# --- Capability endpoint ------------------------------------------------------


def test_fallback_tts_info_elevenlabs() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, tts_provider="elevenlabs"
    )
    response = TestClient(app).get("/api/fallback/tts")

    assert response.status_code == 200
    assert response.json() == {
        "provider": "elevenlabs",
        "speed_supported": True,
        "speed_min": 0.7,
        "speed_max": 1.2,
        "speed_default": 1.0,
    }


def test_fallback_tts_info_google() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, tts_provider="google"
    )
    body = TestClient(app).get("/api/fallback/tts").json()

    assert body["provider"] == "google"
    assert body["speed_supported"] is True
    assert body["speed_min"] == 0.25
    assert body["speed_max"] == 4.0


def test_fallback_tts_info_unsupported_provider() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, tts_provider="mock"
    )
    body = TestClient(app).get("/api/fallback/tts").json()

    assert body == {
        "provider": "mock",
        "speed_supported": False,
        "speed_min": None,
        "speed_max": None,
        "speed_default": None,
    }


# --- Validation ---------------------------------------------------------------


def test_validate_speed_none_is_passthrough() -> None:
    assert validate_fallback_speed(Settings(_env_file=None), None) is None


def test_validate_speed_in_range_elevenlabs() -> None:
    settings = Settings(_env_file=None, tts_provider="elevenlabs")
    assert validate_fallback_speed(settings, 1.1) == 1.1


def test_validate_speed_out_of_range_raises() -> None:
    settings = Settings(_env_file=None, tts_provider="elevenlabs")
    with pytest.raises(FallbackSpeedError, match="out of range"):
        validate_fallback_speed(settings, 1.5)
    with pytest.raises(FallbackSpeedError, match="out of range"):
        validate_fallback_speed(settings, 0.5)


def test_validate_speed_unsupported_provider_raises() -> None:
    settings = Settings(_env_file=None, tts_provider="mock")
    with pytest.raises(FallbackSpeedError, match="does not support speed"):
        validate_fallback_speed(settings, 1.0)


# --- Provider application -----------------------------------------------------


def test_elevenlabs_speed_override_wins_over_env() -> None:
    settings = Settings(_env_file=None, elevenlabs_speed=0.8)
    # Env-only (no override)
    assert build_elevenlabs_voice_settings(settings) == {"speed": 0.8}
    # Per-request override takes precedence for this call.
    assert build_elevenlabs_voice_settings(settings, speed_override=1.15) == {
        "speed": 1.15
    }


def test_create_tts_provider_applies_elevenlabs_override() -> None:
    provider = create_tts_provider(
        Settings(
            _env_file=None,
            tts_provider="elevenlabs",
            elevenlabs_api_key="k",
            elevenlabs_voice_id="v",
        ),
        tts_speed=1.1,
    )
    assert isinstance(provider, ElevenLabsTextToSpeech)
    assert provider.voice_settings == {"speed": 1.1}


def test_create_tts_provider_applies_google_override() -> None:
    provider = create_tts_provider(
        Settings(_env_file=None, tts_provider="google", google_speaking_rate=2.0),
        tts_speed=1.25,
    )
    assert isinstance(provider, GoogleTextToSpeech)
    assert provider.speaking_rate == 1.25


def test_create_tts_provider_without_override_uses_env() -> None:
    eleven = create_tts_provider(
        Settings(
            _env_file=None,
            tts_provider="elevenlabs",
            elevenlabs_api_key="k",
            elevenlabs_voice_id="v",
        )
    )
    assert isinstance(eleven, ElevenLabsTextToSpeech)
    assert eleven.voice_settings is None  # byte-identical default payload

    google = create_tts_provider(
        Settings(_env_file=None, tts_provider="google", google_speaking_rate=2.0)
    )
    assert isinstance(google, GoogleTextToSpeech)
    assert google.speaking_rate == 2.0


# --- Route: speed override reaches the ElevenLabs payload ----------------------


@pytest.mark.anyio
async def test_voice_turn_speed_override_reaches_elevenlabs_payload() -> None:
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(
            200, headers={"content-type": "audio/mpeg"}, content=b"ID3audio"
        )

    from app.providers.stt import MockSpeechToText
    from app.services.voice_pipeline import process_voice_turn
    import io
    from fastapi import UploadFile

    provider = ElevenLabsTextToSpeech(
        api_key="k",
        voice_id="v",
        model_id="eleven_multilingual_v2",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
        voice_settings=build_elevenlabs_voice_settings(
            Settings(_env_file=None), speed_override=1.1
        ),
    )

    result = await process_voice_turn(
        audio=UploadFile(
            filename="recording.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        ),
        settings=Settings(_env_file=None, llm_provider="mock"),
        stt_provider=MockSpeechToText(),
        tts_provider=provider,
    )

    assert result.audio_base64 is not None
    assert request_seen is not None
    assert json.loads(request_seen.content)["voice_settings"] == {"speed": 1.1}


# --- Route: validation + default preservation ---------------------------------


def _mock_settings() -> Settings:
    return Settings(
        _env_file=None,
        stt_provider="mock",
        llm_provider="mock",
        tts_provider="mock",
    )


def test_voice_turn_rejects_speed_on_unsupported_provider() -> None:
    app.dependency_overrides[get_settings] = _mock_settings
    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        data={"speed": "1.0"},
    )
    assert response.status_code == 422
    assert "does not support speed" in response.json()["detail"]


def test_voice_turn_rejects_out_of_range_speed() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,
        stt_provider="mock",
        llm_provider="mock",
        tts_provider="elevenlabs",
        elevenlabs_api_key="k",
        elevenlabs_voice_id="v",
    )
    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        data={"speed": "9.9"},
    )
    assert response.status_code == 422
    assert "out of range" in response.json()["detail"]


def test_voice_turn_without_speed_preserves_default_behavior() -> None:
    app.dependency_overrides[get_settings] = _mock_settings
    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["response"].startswith("I heard:")
    assert body["audio_content_type"] == "audio/wav"


# --- Request-level numeric edge cases (M9.1 regression lock) ------------------


def _elevenlabs_settings() -> Settings:
    # A provider that supports speed, so invalid values reach range validation.
    return Settings(
        _env_file=None,
        stt_provider="mock",
        llm_provider="mock",
        tts_provider="elevenlabs",
        elevenlabs_api_key="k",
        elevenlabs_voice_id="v",
    )


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "9.9", "-1.0", "1e9"])
def test_voice_turn_rejects_non_finite_and_out_of_range_speed(value: str) -> None:
    app.dependency_overrides[get_settings] = _elevenlabs_settings
    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        data={"speed": value},
    )
    assert response.status_code == 422
    # NaN/inf and out-of-range finite values are rejected by range validation,
    # never silently ignored.
    assert "out of range" in response.json()["detail"]


def test_voice_turn_rejects_non_numeric_speed() -> None:
    app.dependency_overrides[get_settings] = _elevenlabs_settings
    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        data={"speed": "abc"},
    )
    # Non-numeric text is rejected by request parsing (Pydantic), also 422.
    assert response.status_code == 422
