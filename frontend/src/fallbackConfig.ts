// Pure helpers for the fallback TTS speed capability (GET /api/fallback/tts).
// No React, no network — deterministically unit-testable.

export type FallbackTtsInfo = {
  provider: string
  speedSupported: boolean
  speedMin: number | null
  speedMax: number | null
  speedDefault: number | null
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number"
}

// Validate and normalize the /api/fallback/tts response shape.
export function parseFallbackTtsInfo(payload: unknown): FallbackTtsInfo {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("provider" in payload) ||
    !("speed_supported" in payload) ||
    typeof (payload as { provider: unknown }).provider !== "string" ||
    typeof (payload as { speed_supported: unknown }).speed_supported !==
      "boolean"
  ) {
    throw new Error("The fallback TTS info response was invalid.")
  }
  const record = payload as Record<string, unknown>
  if (
    !isNumberOrNull(record.speed_min) ||
    !isNumberOrNull(record.speed_max) ||
    !isNumberOrNull(record.speed_default)
  ) {
    throw new Error("The fallback TTS info response was invalid.")
  }
  return {
    provider: record.provider as string,
    speedSupported: record.speed_supported as boolean,
    speedMin: record.speed_min as number | null,
    speedMax: record.speed_max as number | null,
    speedDefault: record.speed_default as number | null,
  }
}

// Clamp a speed value to the provider-reported range. Falls back to the raw
// value if bounds are unavailable (the backend still validates authoritatively).
export function clampFallbackSpeed(
  value: number,
  info: FallbackTtsInfo,
): number {
  if (info.speedMin === null || info.speedMax === null) return value
  if (!Number.isFinite(value)) return info.speedDefault ?? info.speedMin
  return Math.min(info.speedMax, Math.max(info.speedMin, value))
}
