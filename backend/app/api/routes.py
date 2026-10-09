from collections import defaultdict
from threading import Lock
from time import monotonic

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from app.config import Settings, get_settings
from app.providers.stt import STTError
from app.providers.llm import LLMError
from app.providers.tts import TTSError
from app.schemas.voice import (
    SynthesizeRequest,
    SynthesizeResponse,
    RealtimeSessionResponse,
    TranscriptionResponse,
    VoiceTurnResponse,
)
from app.services.transcription import (
    AudioValidationError,
    create_stt_provider,
    transcribe_upload,
)
from app.services.voice_pipeline import VoicePipelineError
from app.services.realtime import RealtimeError, create_realtime_session

router = APIRouter(prefix="/api")
_realtime_rate_limit_lock = Lock()
_realtime_requests: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT_WINDOW_SECONDS = 60.0


def _check_realtime_rate_limit(client_id: str, limit: int) -> None:
    now = monotonic()
    window_start = now - _RATE_LIMIT_WINDOW_SECONDS
    with _realtime_rate_limit_lock:
        timestamps = [
            timestamp
            for timestamp in _realtime_requests[client_id]
            if timestamp > window_start
        ]
        if len(timestamps) >= limit:
            _realtime_requests[client_id] = timestamps
            raise HTTPException(
                status_code=429,
                detail="Too many realtime session requests. Please try again later.",
                headers={"Retry-After": "60"},
            )
        timestamps.append(now)
        _realtime_requests[client_id] = timestamps


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/realtime/session", response_model=RealtimeSessionResponse)
async def realtime_session(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> RealtimeSessionResponse:
    _check_realtime_rate_limit(
        request.client.host if request.client else "unknown",
        settings.realtime_session_rate_limit_per_minute,
    )
    try:
        session = await create_realtime_session(settings)
    except RealtimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return RealtimeSessionResponse(
        client_secret=session.client_secret,
        model=session.model,
        voice=session.voice,
        transcription_model=session.transcription_model,
    )


@router.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    audio: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
) -> TranscriptionResponse:
    try:
        transcript = await transcribe_upload(
            upload=audio,
            settings=settings,
            provider=create_stt_provider(settings),
        )
    except AudioValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except STTError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        await audio.close()

    return TranscriptionResponse(transcript=transcript)


@router.post("/voice-turn", response_model=VoiceTurnResponse)
async def voice_turn(
    audio: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
) -> VoiceTurnResponse:
    from app.services.voice_pipeline import process_voice_turn

    try:
        result = await process_voice_turn(audio=audio, settings=settings)
    except AudioValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VoicePipelineError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (STTError, LLMError, TTSError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        await audio.close()

    return VoiceTurnResponse(
        transcript=result.transcript,
        response=result.response,
        audio_base64=result.audio_base64,
        audio_content_type=result.audio_content_type,
        tts_error=result.tts_error,
    )


@router.post("/synthesize", response_model=SynthesizeResponse)
async def synthesize(
    request: SynthesizeRequest,
    settings: Settings = Depends(get_settings),
) -> SynthesizeResponse:
    from app.services.voice_pipeline import synthesize_response

    try:
        audio_base64, audio_content_type = await synthesize_response(
            text=request.text,
            settings=settings,
        )
    except VoicePipelineError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TTSError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return SynthesizeResponse(
        audio_base64=audio_base64,
        audio_content_type=audio_content_type,
    )
