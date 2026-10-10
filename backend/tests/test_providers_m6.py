import json

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.providers.tts import (
    ElevenLabsTextToSpeech,
    GoogleTextToSpeech,
    google_audio_config_kwargs,
)
from app.services.voice_pipeline import (
    build_elevenlabs_voice_settings,
    create_tts_provider,
)


# --- Defaults unset: behavior unchanged --------------------------------------


def test_elevenlabs_speed_absent_by_default() -> None:
    assert build_elevenlabs_voice_settings(Settings(_env_file=None)) is None


def test_google_audio_config_kwargs_empty_when_unset() -> None:
    assert google_audio_config_kwargs(None) == {}


def test_google_provider_has_no_speaking_rate_by_default() -> None:
    provider = create_tts_provider(Settings(_env_file=None, tts_provider="google"))

    assert isinstance(provider, GoogleTextToSpeech)
    assert provider.speaking_rate is None


# --- Configured values are wired through --------------------------------------


def test_elevenlabs_speed_included_when_configured() -> None:
    assert build_elevenlabs_voice_settings(
        Settings(_env_file=None, elevenlabs_speed=1.1)
    ) == {"speed": 1.1}


def test_elevenlabs_speed_combines_with_other_settings() -> None:
    settings = Settings(
        _env_file=None,
        elevenlabs_stability=0.5,
        elevenlabs_speed=0.9,
    )

    assert build_elevenlabs_voice_settings(settings) == {
        "stability": 0.5,
        "speed": 0.9,
    }


def test_google_audio_config_kwargs_includes_rate_when_set() -> None:
    assert google_audio_config_kwargs(1.5) == {"speaking_rate": 1.5}


def test_google_provider_receives_configured_speaking_rate() -> None:
    provider = create_tts_provider(
        Settings(_env_file=None, tts_provider="google", google_speaking_rate=1.25)
    )

    assert isinstance(provider, GoogleTextToSpeech)
    assert provider.speaking_rate == 1.25


def test_create_tts_provider_passes_elevenlabs_speed() -> None:
    provider = create_tts_provider(
        Settings(
            _env_file=None,
            tts_provider="elevenlabs",
            elevenlabs_api_key="k",
            elevenlabs_voice_id="v",
            elevenlabs_speed=1.2,
        )
    )

    assert isinstance(provider, ElevenLabsTextToSpeech)
    assert provider.voice_settings == {"speed": 1.2}


# --- Payload construction -----------------------------------------------------


@pytest.mark.anyio
async def test_elevenlabs_payload_includes_speed_when_set() -> None:
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
        voice_settings={"speed": 1.1},
    )

    await provider.synthesize("Hello")

    assert request_seen is not None
    assert json.loads(request_seen.content) == {
        "text": "Hello",
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {"speed": 1.1},
    }


# --- Validation ---------------------------------------------------------------


@pytest.mark.parametrize("value", [0.69, 1.21, 0.0, 2.0])
def test_elevenlabs_speed_out_of_range_is_rejected(value: float) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, elevenlabs_speed=value)


@pytest.mark.parametrize("value", [0.24, 4.01, 0.0, 10.0])
def test_google_speaking_rate_out_of_range_is_rejected(value: float) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, google_speaking_rate=value)


@pytest.mark.parametrize("value", [0.7, 1.0, 1.2])
def test_elevenlabs_speed_accepts_documented_range(value: float) -> None:
    assert Settings(_env_file=None, elevenlabs_speed=value).elevenlabs_speed == value


@pytest.mark.parametrize("value", [0.25, 1.0, 4.0])
def test_google_speaking_rate_accepts_documented_range(value: float) -> None:
    assert (
        Settings(_env_file=None, google_speaking_rate=value).google_speaking_rate
        == value
    )


# --- Google SDK AudioConfig construction (credential-free, no network) --------


def test_google_audio_config_applies_speaking_rate_via_sdk() -> None:
    # Constructs the real SDK message locally; no client, credentials, or network.
    texttospeech = pytest.importorskip("google.cloud.texttospeech")

    configured = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3,
        **google_audio_config_kwargs(1.5),
    )
    assert configured.speaking_rate == 1.5

    # Unset -> the helper adds nothing; the proto default 0.0 tells Google to use
    # its own default rate, so we do not override the SDK default.
    default = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3,
        **google_audio_config_kwargs(None),
    )
    assert default.speaking_rate == 0.0
