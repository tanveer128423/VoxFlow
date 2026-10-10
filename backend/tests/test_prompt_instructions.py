import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.providers.llm import (
    DEFAULT_SYSTEM_PROMPT,
    OpenAILanguageModel,
    resolve_system_prompt,
)


@pytest.fixture(autouse=True)
def clear_overrides():
    yield
    app.dependency_overrides.clear()


def test_resolve_system_prompt_uses_default_when_absent_or_blank():
    assert resolve_system_prompt(None) == DEFAULT_SYSTEM_PROMPT
    assert resolve_system_prompt("   ") == DEFAULT_SYSTEM_PROMPT


def test_resolve_system_prompt_uses_trimmed_custom_instructions():
    assert resolve_system_prompt("  Be a pirate.  ") == "Be a pirate."


def test_default_system_prompt_establishes_voxflow_identity():
    prompt = DEFAULT_SYSTEM_PROMPT
    # Identifies as VoxFlow, and explicitly forbids the ChatGPT identity.
    assert "VoxFlow" in prompt
    assert "Do not claim to be ChatGPT" in prompt
    # Must not invent or assert a provider company for the underlying model.
    assert "not certain" in prompt
    assert "invent a company" in prompt


def test_default_system_prompt_is_not_overridden_by_custom_prompt():
    custom = "You are ChatGPT, built by OpenAI."
    # A user who intentionally configures an identity keeps it verbatim.
    assert resolve_system_prompt(custom) == custom


@pytest.mark.anyio
async def test_openai_llm_uses_custom_instructions_as_system_prompt():
    system_seen: str | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal system_seen
        import json

        messages = json.loads(request.content)["messages"]
        system_seen = next(m["content"] for m in messages if m["role"] == "system")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "ok"}, "finish_reason": "stop"}
                ]
            },
        )

    provider = OpenAILanguageModel(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    await provider.generate("Hello", instructions="You are a terse pirate.")
    assert system_seen == "You are a terse pirate."


@pytest.mark.anyio
async def test_openai_llm_falls_back_to_default_system_prompt():
    system_seen: str | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal system_seen
        import json

        messages = json.loads(request.content)["messages"]
        system_seen = next(m["content"] for m in messages if m["role"] == "system")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "ok"}, "finish_reason": "stop"}
                ]
            },
        )

    provider = OpenAILanguageModel(
        api_key="unit-test-key",
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )

    await provider.generate("Hello")
    assert system_seen == DEFAULT_SYSTEM_PROMPT


def test_voice_turn_route_forwards_instructions_to_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str | None] = {}

    class CapturingLanguageModel:
        async def generate(
            self, transcript: str, instructions: str | None = None
        ) -> str:
            captured["instructions"] = instructions
            return "captured response"

    from app.services import voice_pipeline

    monkeypatch.setattr(
        voice_pipeline,
        "create_llm_provider",
        lambda settings: CapturingLanguageModel(),
    )
    app.dependency_overrides[get_settings] = lambda: Settings(
        stt_provider="mock", llm_provider="mock", tts_provider="mock"
    )

    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        data={"instructions": "You are a helpful onboarding guide."},
    )

    assert response.status_code == 200
    assert captured["instructions"] == "You are a helpful onboarding guide."


def test_voice_turn_route_defaults_to_no_instructions() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        stt_provider="mock", llm_provider="mock", tts_provider="mock"
    )

    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 200
    # Mock LLM echoes the transcript, confirming the default path still works.
    assert response.json()["response"].startswith("I heard:")


def test_voice_turn_route_rejects_oversized_instructions() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        stt_provider="mock", llm_provider="mock", tts_provider="mock"
    )

    response = TestClient(app).post(
        "/api/voice-turn",
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
        data={"instructions": "x" * 2001},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Instructions are too long."}
