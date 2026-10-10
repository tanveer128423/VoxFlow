// Pure helpers for live-conversation voice + server-VAD configuration.
// No React, no network — safe to unit test in isolation.

import type {
  RealtimeSessionConfig,
  RealtimeTurnDetection,
} from "./api/voiceApi"

// Bounds mirror the backend Pydantic constraints (schemas/voice.py). The
// backend remains the source of truth; these only prevent sending out-of-range
// values and keep the UI sliders honest.
export const VAD_BOUNDS = {
  threshold: { min: 0, max: 1 },
  prefix_padding_ms: { min: 0, max: 2000 },
  silence_duration_ms: { min: 0, max: 5000 },
} as const

export type RealtimeVoiceOptions = {
  voices: string[]
  defaultVoice: string
  defaultTurnDetection: RealtimeTurnDetection
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

// Clamp each VAD field to its supported range; integers for the millisecond
// fields, as the backend expects ints.
export function clampTurnDetection(
  turnDetection: RealtimeTurnDetection,
): RealtimeTurnDetection {
  return {
    threshold: clampNumber(
      turnDetection.threshold,
      VAD_BOUNDS.threshold.min,
      VAD_BOUNDS.threshold.max,
    ),
    prefix_padding_ms: Math.round(
      clampNumber(
        turnDetection.prefix_padding_ms,
        VAD_BOUNDS.prefix_padding_ms.min,
        VAD_BOUNDS.prefix_padding_ms.max,
      ),
    ),
    silence_duration_ms: Math.round(
      clampNumber(
        turnDetection.silence_duration_ms,
        VAD_BOUNDS.silence_duration_ms.min,
        VAD_BOUNDS.silence_duration_ms.max,
      ),
    ),
  }
}

export function turnDetectionEquals(
  a: RealtimeTurnDetection,
  b: RealtimeTurnDetection,
): boolean {
  return (
    a.threshold === b.threshold &&
    a.prefix_padding_ms === b.prefix_padding_ms &&
    a.silence_duration_ms === b.silence_duration_ms
  )
}

// Build the config passed to conversation.connect(). Fields are included only
// when they differ from the backend defaults, preserving current behavior when
// the user leaves settings unchanged.
export function buildRealtimeConfig(input: {
  instructions?: string
  voice?: string
  turnDetection?: RealtimeTurnDetection
  options?: RealtimeVoiceOptions
}): RealtimeSessionConfig {
  const config: RealtimeSessionConfig = {}

  const instructions = input.instructions?.trim()
  if (instructions) config.instructions = instructions

  if (
    input.voice &&
    (!input.options || input.voice !== input.options.defaultVoice)
  ) {
    config.voice = input.voice
  }

  if (input.turnDetection) {
    const clamped = clampTurnDetection(input.turnDetection)
    if (
      !input.options ||
      !turnDetectionEquals(clamped, input.options.defaultTurnDetection)
    ) {
      config.turn_detection = clamped
    }
  }

  return config
}

// Validate and normalize the /api/realtime/voices response shape.
export function parseVoiceOptions(payload: unknown): RealtimeVoiceOptions {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("voices" in payload) ||
    !("default_voice" in payload) ||
    !("default_turn_detection" in payload) ||
    !Array.isArray((payload as { voices: unknown }).voices) ||
    !(payload as { voices: unknown[] }).voices.every(
      (voice) => typeof voice === "string",
    ) ||
    typeof (payload as { default_voice: unknown }).default_voice !== "string"
  ) {
    throw new Error("The voice options response was invalid.")
  }
  const turnDetection = (payload as { default_turn_detection: unknown })
    .default_turn_detection
  if (
    typeof turnDetection !== "object" ||
    turnDetection === null ||
    typeof (turnDetection as RealtimeTurnDetection).threshold !== "number" ||
    typeof (turnDetection as RealtimeTurnDetection).prefix_padding_ms !==
      "number" ||
    typeof (turnDetection as RealtimeTurnDetection).silence_duration_ms !==
      "number"
  ) {
    throw new Error("The voice options response was invalid.")
  }
  const typed = payload as {
    voices: string[]
    default_voice: string
    default_turn_detection: RealtimeTurnDetection
  }
  if (typed.voices.length === 0) {
    throw new Error("The voice options response was invalid.")
  }
  return {
    voices: typed.voices,
    defaultVoice: typed.default_voice,
    defaultTurnDetection: typed.default_turn_detection,
  }
}
