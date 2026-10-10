from collections import defaultdict
from threading import Lock
from time import monotonic

from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)

from app.config import Settings, get_settings
from app.providers.stt import STTError
from app.providers.llm import LLMError
from app.providers.tts import TTSError
from app.schemas.voice import (
    MAX_INSTRUCTIONS_LENGTH,
    SUPPORTED_REALTIME_VOICES,
    FallbackTtsInfoResponse,
    SynthesizeRequest,
    SynthesizeResponse,
    RealtimeSessionRequest,
    RealtimeSessionResponse,
    RealtimeTurnDetection,
    RealtimeVoiceOptionsResponse,
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


@router.get("/realtime/voices", response_model=RealtimeVoiceOptionsResponse)
async def realtime_voices(
    settings: Settings = Depends(get_settings),
) -> RealtimeVoiceOptionsResponse:
    default_voice = (
        settings.realtime_voice
        if settings.realtime_voice in SUPPORTED_REALTIME_VOICES
        else SUPPORTED_REALTIME_VOICES[0]
    )
    return RealtimeVoiceOptionsResponse(
        voices=list(SUPPORTED_REALTIME_VOICES),
        default_voice=default_voice,
        default_turn_detection=RealtimeTurnDetection(),
    )


@router.post("/realtime/session", response_model=RealtimeSessionResponse)
async def realtime_session(
    request: Request,
    config: RealtimeSessionRequest | None = Body(default=None),
    settings: Settings = Depends(get_settings),
) -> RealtimeSessionResponse:
    _check_realtime_rate_limit(
        request.client.host if request.client else "unknown",
        settings.realtime_session_rate_limit_per_minute,
    )
    try:
        session = await create_realtime_session(settings, config)
    except RealtimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return RealtimeSessionResponse(
        client_secret=session.client_secret,
        model=session.model,
        voice=session.voice,
        transcription_model=session.transcription_model,
        instructions=session.instructions,
        turn_detection=session.turn_detection,
    )


@router.get("/fallback/tts", response_model=FallbackTtsInfoResponse)
async def fallback_tts_info(
    settings: Settings = Depends(get_settings),
) -> FallbackTtsInfoResponse:
    from app.services.voice_pipeline import fallback_tts_speed_info

    return FallbackTtsInfoResponse(**fallback_tts_speed_info(settings))


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
    instructions: str | None = Form(default=None),
    speed: float | None = Form(default=None),
    settings: Settings = Depends(get_settings),
) -> VoiceTurnResponse:
    from app.services.voice_pipeline import (
        FallbackSpeedError,
        process_voice_turn,
        validate_fallback_speed,
    )

    if instructions is not None and len(instructions) > MAX_INSTRUCTIONS_LENGTH:
        raise HTTPException(
            status_code=422,
            detail="Instructions are too long.",
        )

    try:
        tts_speed = validate_fallback_speed(settings, speed)
    except FallbackSpeedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        result = await process_voice_turn(
            audio=audio,
            settings=settings,
            instructions=instructions,
            tts_speed=tts_speed,
        )
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
        timings=result.timings,
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
