// Pure, dependency-free audio/session settings helpers for VoxFlow.
//
// No React, no Web Audio, no DOM, no network — deterministically unit-testable.
// These back the per-agent output volume, microphone-processing constraints, and
// the minimum-response-delay feature. Defaults preserve current behavior
// (volume 1.0, all mic-processing flags on, minimum delay 0 ms).

export const VOLUME_BOUNDS = { min: 0, max: 1 } as const
export const MIN_RESPONSE_DELAY_BOUNDS = { min: 0, max: 5000 } as const
export const INTERRUPT_MIN_WORDS_BOUNDS = { min: 0, max: 100 } as const

export const DEFAULT_VOLUME = 1
export const DEFAULT_MIN_RESPONSE_DELAY_MS = 0
export const DEFAULT_INTERRUPT_MIN_WORDS = 0
// Ambience is OFF by default; when enabled this gain keeps typing subtle.
export const AMBIENCE_VOLUME_BOUNDS = { min: 0, max: 1 } as const
export const DEFAULT_AMBIENCE_ENABLED = false
export const DEFAULT_AMBIENCE_VOLUME = 0.3

export type MicProcessing = {
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

// Current default behavior: browser microphone processing fully enabled.
export const DEFAULT_MIC_PROCESSING: MicProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

// Output playback volume, 0.0 (silent) to 1.0 (full).
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME
  return clampNumber(value, VOLUME_BOUNDS.min, VOLUME_BOUNDS.max)
}

// Minimum response delay in whole milliseconds, 0..5000.
export function clampMinResponseDelayMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_RESPONSE_DELAY_MS
  return Math.round(
    clampNumber(value, MIN_RESPONSE_DELAY_BOUNDS.min, MIN_RESPONSE_DELAY_BOUNDS.max),
  )
}

// Interruption gate threshold as a whole number of assistant words, 0..100.
export function clampInterruptMinWords(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERRUPT_MIN_WORDS
  return Math.round(
    clampNumber(value, INTERRUPT_MIN_WORDS_BOUNDS.min, INTERRUPT_MIN_WORDS_BOUNDS.max),
  )
}

// Background ambience gain, 0.0 (silent) to 1.0.
export function clampAmbienceVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AMBIENCE_VOLUME
  return clampNumber(value, AMBIENCE_VOLUME_BOUNDS.min, AMBIENCE_VOLUME_BOUNDS.max)
}

// Defensive normalization of a stored/edited mic-processing object. Each field
// defaults to true (current behavior) when missing or not a boolean.
export function normalizeMicProcessing(value: unknown): MicProcessing {
  if (!value || typeof value !== "object") return { ...DEFAULT_MIC_PROCESSING }
  const record = value as Record<string, unknown>
  const flag = (key: keyof MicProcessing): boolean =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : true
  return {
    echoCancellation: flag("echoCancellation"),
    noiseSuppression: flag("noiseSuppression"),
    autoGainControl: flag("autoGainControl"),
  }
}

// Build the `audio` MediaTrackConstraints passed to getUserMedia from the
// per-agent microphone-processing settings. These take effect only at stream
// acquisition (the next session/recording), never mid-session.
export function buildAudioConstraints(mic: MicProcessing): MediaTrackConstraints {
  return {
    echoCancellation: mic.echoCancellation,
    noiseSuppression: mic.noiseSuppression,
    autoGainControl: mic.autoGainControl,
  }
}

// Apply a clamped volume to any object exposing a `volume` field (an
// HTMLAudioElement or a test double). Returns the value that was set so callers
// and tests can assert the real configuration changed, not just UI state.
export function applyVolume(target: { volume: number }, value: number): number {
  const clamped = clampVolume(value)
  target.volume = clamped
  return clamped
}

// Remaining milliseconds to wait before the FIRST assistant audio playback of a
// turn, given the end-of-utterance time, the time the audio became ready, and
// the configured minimum delay. Never negative and never adds extra delay when
// the audio is already later than the minimum (audio that is "late" plays
// immediately). All times share one monotonic clock (e.g. performance.now()).
export function computePlaybackDelayMs(
  eouAt: number,
  readyAt: number,
  minDelayMs: number,
): number {
  if (!Number.isFinite(eouAt) || !Number.isFinite(readyAt)) return 0
  const target = eouAt + Math.max(0, minDelayMs)
  return Math.max(0, Math.round(target - readyAt))
}
