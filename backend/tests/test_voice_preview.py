import base64

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.services.voice_preview import (
    PREVIEW_MODEL,
    VoicePreviewError,
    clear_voice_preview_cache,
    synthesize_voice_preview,
)


@pytest.fixture(autouse=True)
def _reset_state():
    clear_voice_preview_cache()
    yield
    app.dependency_overrides.clear()
    clear_voice_preview_cache()


# --- Route-level: no network, no credentials --------------------------------


def test_voice_preview_rejects_unsupported_voice_without_network():
    app.dependency_overrides[get_settings] = lambda: Settings(
        openai_api_key="unit-test-key"
    )

    response = TestClient(app).post(
        "/api/realtime/voice-preview", json={"voice": "not-a-voice"}
    )

    assert response.status_code == 422


def test_voice_preview_returns_502_when_not_configured():
    app.dependency_overrides[get_settings] = lambda: Settings(openai_api_key="")

    response = TestClient(app).post(
        "/api/realtime/voice-preview", json={"voice": "alloy"}
    )

    assert response.status_code == 502
    assert "not configured" in response.json()["detail"].lower()


# --- Service-level: injected transport, never a real call -------------------


@pytest.mark.anyio
async def test_synthesize_voice_preview_sends_voice_and_caches():
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        import json as _json

        body = _json.loads(request.content.decode())
        assert body["voice"] == "verse"
        assert body["model"] == PREVIEW_MODEL
        # The standard key is used server-side only.
        assert request.headers["Authorization"] == "Bearer standard-key"
        return httpx.Response(200, content=b"\x00\x01audio")

    settings = Settings(openai_api_key="standard-key")

    first = await synthesize_voice_preview(
        settings, "verse", transport=httpx.MockTransport(handler)
    )
    assert first == (base64.b64encode(b"\x00\x01audio").decode("ascii"), "audio/mpeg")
    assert calls == 1

    # Second call for the same voice is served from cache (no second request).
    second = await synthesize_voice_preview(
        settings, "verse", transport=httpx.MockTransport(handler)
    )
    assert second == first
    assert calls == 1


@pytest.mark.anyio
async def test_synthesize_voice_preview_maps_unavailable_voice():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "unsupported voice"})

    with pytest.raises(VoicePreviewError) as excinfo:
        await synthesize_voice_preview(
            Settings(openai_api_key="standard-key"),
            "cedar",
            transport=httpx.MockTransport(handler),
        )
    assert "not available" in str(excinfo.value).lower()


@pytest.mark.anyio
async def test_synthesize_voice_preview_requires_api_key():
    with pytest.raises(VoicePreviewError):
        await synthesize_voice_preview(Settings(openai_api_key=""), "alloy")
