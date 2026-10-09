import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.services.realtime import RealtimeError, create_realtime_session


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
