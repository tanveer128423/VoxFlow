export type TranscriptionResult = {
  transcript: string
}

export type VoiceTurnTimings = {
  stt_ms: number | null
  llm_ms: number | null
  tts_ms: number | null
  total_ms: number | null
}

export type VoiceTurnResult = TranscriptionResult & {
  response: string
  audio_base64: string | null
  audio_content_type: string | null
  tts_error: string | null
  timings: VoiceTurnTimings | null
}

function parseTimings(value: unknown): VoiceTurnTimings | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "object") return null
  const isMs = (field: unknown): field is number | null =>
    field === null || typeof field === "number"
  const record = value as Record<string, unknown>
  if (
    !isMs(record.stt_ms) ||
    !isMs(record.llm_ms) ||
    !isMs(record.tts_ms) ||
    !isMs(record.total_ms)
  ) {
    return null
  }
  return {
    stt_ms: record.stt_ms as number | null,
    llm_ms: record.llm_ms as number | null,
    tts_ms: record.tts_ms as number | null,
    total_ms: record.total_ms as number | null,
  }
}

export type RealtimeTurnDetection = {
  threshold: number
  prefix_padding_ms: number
  silence_duration_ms: number
}

export type RealtimeSessionConfig = {
  voice?: string
  instructions?: string
  turn_detection?: RealtimeTurnDetection
}

export type RealtimeSession = {
  client_secret: string
  model: string
  voice: string
  transcription_model: string
  instructions: string | null
  turn_detection: RealtimeTurnDetection
}

function isTurnDetection(value: unknown): value is RealtimeTurnDetection {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RealtimeTurnDetection).threshold === "number" &&
    typeof (value as RealtimeTurnDetection).prefix_padding_ms === "number" &&
    typeof (value as RealtimeTurnDetection).silence_duration_ms === "number"
  )
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "")

export function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`
}

export async function fetchRealtimeVoiceOptions(): Promise<unknown> {
  const response = await fetch(apiUrl("/api/realtime/voices"), {
    method: "GET",
  })
  if (!response.ok) {
    throw new Error("Could not load the available voices.")
  }
  return response.json()
}

export async function createRealtimeSession(
  config: RealtimeSessionConfig = {},
): Promise<RealtimeSession> {
  const response = await fetch(apiUrl("/api/realtime/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "detail" in payload &&
      typeof payload.detail === "string"
        ? payload.detail
        : "Realtime voice setup failed."
    throw new Error(detail)
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("client_secret" in payload) ||
    !("model" in payload) ||
    !("voice" in payload) ||
    !("transcription_model" in payload) ||
    !("turn_detection" in payload) ||
    typeof payload.client_secret !== "string" ||
    typeof payload.model !== "string" ||
    typeof payload.voice !== "string" ||
    typeof payload.transcription_model !== "string" ||
    !isTurnDetection(payload.turn_detection) ||
    !(
      !("instructions" in payload) ||
      payload.instructions === null ||
      typeof payload.instructions === "string"
    )
  ) {
    throw new Error("The realtime session response was invalid.")
  }
  const instructions =
    "instructions" in payload && typeof payload.instructions === "string"
      ? payload.instructions
      : null
  return {
    client_secret: payload.client_secret,
    model: payload.model,
    voice: payload.voice,
    transcription_model: payload.transcription_model,
    instructions,
    turn_detection: payload.turn_detection,
  }
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

export async function fetchFallbackTtsInfo(): Promise<unknown> {
  const response = await fetch(apiUrl("/api/fallback/tts"), { method: "GET" })
  if (!response.ok) {
    throw new Error("Could not load fallback TTS capabilities.")
  }
  return response.json()
}

export type VoicePreviewResult = {
  voice: string
  audio_base64: string
  audio_content_type: string
}

// Request a short audio sample for a Live Realtime voice. User-initiated only;
// never call this automatically. Requires a configured backend OpenAI key.
export async function fetchVoicePreview(
  voice: string,
): Promise<VoicePreviewResult> {
  const response = await fetch(apiUrl("/api/realtime/voice-preview"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice }),
  })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "detail" in payload &&
      typeof payload.detail === "string"
        ? payload.detail
        : "Voice preview is unavailable."
    throw new Error(detail)
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("audio_base64" in payload) ||
    !("audio_content_type" in payload) ||
    typeof (payload as VoicePreviewResult).audio_base64 !== "string" ||
    typeof (payload as VoicePreviewResult).audio_content_type !== "string"
  ) {
    throw new Error("The voice preview response was invalid.")
  }
  const typed = payload as VoicePreviewResult
  return {
    voice,
    audio_base64: typed.audio_base64,
    audio_content_type: typed.audio_content_type,
  }
}

export async function processVoiceTurn(
  audio: Blob,
  instructions?: string,
  speed?: number,
): Promise<VoiceTurnResult> {
  const formData = new FormData()
  formData.append("audio", audio, recordingFilename(audio))
  if (instructions && instructions.trim()) {
    formData.append("instructions", instructions)
  }
  if (typeof speed === "number" && Number.isFinite(speed)) {
    formData.append("speed", String(speed))
  }

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
    timings:
      "timings" in payload ? parseTimings(payload.timings) : null,
  }
}
