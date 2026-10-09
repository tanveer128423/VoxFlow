export type TranscriptionResult = {
  transcript: string
}

export type VoiceTurnResult = TranscriptionResult & {
  response: string
  audio_base64: string | null
  audio_content_type: string | null
  tts_error: string | null
}

export type SynthesisResult = {
  audio_base64: string
  audio_content_type: string
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "")

export function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`
}

export function createAudioObjectUrl(
  audioBase64: string,
  contentType: string,
): string {
  const binary = atob(audioBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const blob = new Blob([bytes], { type: contentType })
  return URL.createObjectURL(blob)
}

function recordingFilename(audio: Blob): string {
  const container = audio.type.split(";", 1)[0].toLowerCase()
  const extensionByType: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
  }
  return `recording.${extensionByType[container] ?? "webm"}`
}

export async function transcribeAudio(
  audio: Blob,
): Promise<TranscriptionResult> {
  const formData = new FormData()
  formData.append("audio", audio, recordingFilename(audio))

  const response = await fetch(apiUrl('/api/transcribe'), {
    method: 'POST',
    body: formData,
  })

  const payload: unknown = await response.json()
  if (!response.ok) {
    const detail =
      typeof payload === 'object' &&
      payload !== null &&
      'detail' in payload &&
      typeof payload.detail === 'string'
        ? payload.detail
        : 'Transcription failed.'
    throw new Error(detail)
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('transcript' in payload) ||
    typeof payload.transcript !== 'string'
  ) {
    throw new Error('The transcription response was invalid.')
  }

  return { transcript: payload.transcript }
}

export async function processVoiceTurn(audio: Blob): Promise<VoiceTurnResult> {
  const formData = new FormData()
  formData.append("audio", audio, recordingFilename(audio))

  const response = await fetch(apiUrl('/api/voice-turn'), {
    method: 'POST',
    body: formData,
  })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const detail =
      typeof payload === 'object' &&
      payload !== null &&
      'detail' in payload &&
      typeof payload.detail === 'string'
        ? payload.detail
        : 'Voice turn failed.'
    throw new Error(detail)
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('transcript' in payload) ||
    !('response' in payload) ||
    !('audio_base64' in payload) ||
    !('audio_content_type' in payload) ||
    !('tts_error' in payload) ||
    typeof payload.transcript !== 'string' ||
    typeof payload.response !== 'string' ||
    (payload.audio_base64 !== null &&
      typeof payload.audio_base64 !== 'string') ||
    (payload.audio_content_type !== null &&
      typeof payload.audio_content_type !== 'string') ||
    (payload.tts_error !== null && typeof payload.tts_error !== 'string')
  ) {
    throw new Error('The voice response was invalid.')
  }
  return {
    transcript: payload.transcript,
    response: payload.response,
    audio_base64: payload.audio_base64,
    audio_content_type: payload.audio_content_type,
    tts_error: payload.tts_error,
  }
}

export async function synthesizeResponse(
  text: string,
): Promise<SynthesisResult> {
  const response = await fetch(apiUrl('/api/synthesize'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const detail =
      typeof payload === 'object' &&
      payload !== null &&
      'detail' in payload &&
      typeof payload.detail === 'string'
        ? payload.detail
        : 'Speech synthesis failed.'
    throw new Error(detail)
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('audio_base64' in payload) ||
    !('audio_content_type' in payload) ||
    typeof payload.audio_base64 !== 'string' ||
    typeof payload.audio_content_type !== 'string'
  ) {
    throw new Error('The speech synthesis response was invalid.')
  }
  return {
    audio_base64: payload.audio_base64,
    audio_content_type: payload.audio_content_type,
  }
}
