from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.config import Settings, get_settings
from app.providers.stt import STTError
from app.providers.llm import LLMError
from app.providers.tts import TTSError
from app.schemas.voice import (
    SynthesizeRequest,
    SynthesizeResponse,
    TranscriptionResponse,
    VoiceTurnResponse,
)
from app.services.transcription import (
    AudioValidationError,
    create_stt_provider,
    transcribe_upload,
)
from app.services.voice_pipeline import VoicePipelineError

router = APIRouter(prefix="/api")


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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
