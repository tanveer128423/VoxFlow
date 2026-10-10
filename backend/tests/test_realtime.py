import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.providers.llm import DEFAULT_SYSTEM_PROMPT
from app.schemas.voice import (
    SUPPORTED_REALTIME_VOICES,
    RealtimeSessionRequest,
    RealtimeTurnDetection,
)
from app.services.realtime import RealtimeError, create_realtime_session


def test_realtime_voices_endpoint_returns_whitelist_and_defaults():
    app.dependency_overrides[get_settings] = lambda: Settings(
        realtime_voice="marin"
    )

    response = TestClient(app).get("/api/realtime/voices")

    assert response.status_code == 200
    body = response.json()
    assert body["voices"] == list(SUPPORTED_REALTIME_VOICES)
    assert body["default_voice"] == "marin"
    assert body["default_turn_detection"] == {
        "threshold": 0.65,
        "prefix_padding_ms": 300,
        "silence_duration_ms": 600,
    }


def test_realtime_voices_endpoint_falls_back_to_supported_default():
    app.dependency_overrides[get_settings] = lambda: Settings(
        realtime_voice="not-a-supported-voice"
    )

    response = TestClient(app).get("/api/realtime/voices")

    assert response.status_code == 200
    assert response.json()["default_voice"] == SUPPORTED_REALTIME_VOICES[0]


@pytest.fixture(autouse=True)
def clear_settings_override():
    yield
    app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_realtime_session_uses_ephemeral_secret_without_exposing_standard_key():
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(200, json={"value": "ek_test_ephemeral"})

    session = await create_realtime_session(
        Settings(
            openai_api_key="unit-test-standard-key",
            realtime_model="gpt-realtime-2.1-mini",
            realtime_voice="marin",
        ),
        transport=httpx.MockTransport(handler),
    )

    assert session.client_secret == "ek_test_ephemeral"
    assert session.model == "gpt-realtime-2.1-mini"
    assert session.voice == "marin"
    assert session.transcription_model == "gpt-4o-mini-transcribe"
    assert request_seen is not None
    assert request_seen.url == "https://api.openai.com/v1/realtime/client_secrets"
    assert "Authorization" in request_seen.headers
    assert b"unit-test-standard-key" not in request_seen.content


@pytest.mark.anyio
async def test_realtime_session_defaults_apply_voxflow_identity():
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(200, json={"value": "ek_default"})

    session = await create_realtime_session(
        Settings(openai_api_key="unit-test-key", realtime_voice="marin"),
        transport=httpx.MockTransport(handler),
    )

    assert session.voice == "marin"
    # With no custom prompt, Live mode applies the shared default identity so
    # the assistant never self-identifies as the underlying model (ChatGPT).
    assert session.instructions == DEFAULT_SYSTEM_PROMPT
    assert session.turn_detection == RealtimeTurnDetection()
    assert request_seen is not None
    payload = json.loads(request_seen.content)
    assert payload["session"]["instructions"] == DEFAULT_SYSTEM_PROMPT
    assert "VoxFlow" in payload["session"]["instructions"]
    assert payload["session"]["audio"]["output"]["voice"] == "marin"


@pytest.mark.anyio
async def test_realtime_session_applies_validated_custom_config():
    request_seen: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_seen
        request_seen = request
        return httpx.Response(200, json={"value": "ek_custom"})

    config = RealtimeSessionRequest(
        voice="verse",
        instructions="  You are a terse pirate assistant.  ",
        turn_detection=RealtimeTurnDetection(
            threshold=0.4,
            prefix_padding_ms=150,
            silence_duration_ms=900,
        ),
    )

    session = await create_realtime_session(
        Settings(openai_api_key="unit-test-key", realtime_voice="marin"),
        config,
        transport=httpx.MockTransport(handler),
    )

    assert session.voice == "verse"
    assert session.instructions == "You are a terse pirate assistant."
    assert session.turn_detection.threshold == 0.4
    assert session.turn_detection.silence_duration_ms == 900
    assert request_seen is not None
    payload = json.loads(request_seen.content)
    assert payload["session"]["audio"]["output"]["voice"] == "verse"
    assert payload["session"]["instructions"] == "You are a terse pirate assistant."


def test_realtime_session_route_rejects_unsupported_voice():
    app.dependency_overrides[get_settings] = lambda: Settings(
        openai_api_key="unit-test-key"
    )

    response = TestClient(app).post(
        "/api/realtime/session", json={"voice": "not-a-real-voice"}
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    "turn_detection",
    [
        {"threshold": 1.5},
        {"threshold": -0.1},
        {"prefix_padding_ms": -1},
        {"silence_duration_ms": 99999},
    ],
)
def test_realtime_session_route_rejects_out_of_range_vad(turn_detection):
    app.dependency_overrides[get_settings] = lambda: Settings(
        openai_api_key="unit-test-key"
    )

    response = TestClient(app).post(
        "/api/realtime/session", json={"turn_detection": turn_detection}
    )

    assert response.status_code == 422


def test_realtime_session_route_rejects_unknown_fields():
    app.dependency_overrides[get_settings] = lambda: Settings(
        openai_api_key="unit-test-key"
    )

    response = TestClient(app).post(
        "/api/realtime/session", json={"model": "attacker-chosen-model"}
    )

    assert response.status_code == 422


@pytest.mark.anyio
async def test_realtime_session_rejects_invalid_upstream_response():
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(200, json={"unexpected": "payload"})

    with pytest.raises(RealtimeError, match="invalid session"):
        await create_realtime_session(
            Settings(openai_api_key="unit-test-key"),
            transport=httpx.MockTransport(handler),
        )


def test_realtime_session_route_returns_only_ephemeral_secret():
    app.dependency_overrides[get_settings] = lambda: Settings(openai_api_key="")

    response = TestClient(app).post("/api/realtime/session")

    assert response.status_code == 502
    assert response.json() == {"detail": "Realtime voice is not configured."}


def test_realtime_session_route_rate_limits_client():
    app.dependency_overrides[get_settings] = lambda: Settings(
        openai_api_key="unit-test-key",
        realtime_session_rate_limit_per_minute=0,
    )

    response = TestClient(app).post("/api/realtime/session")

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"
