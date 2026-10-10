import { describe, expect, it } from "vitest"

import {
  clampFallbackSpeed,
  parseFallbackTtsInfo,
  type FallbackTtsInfo,
} from "./fallbackConfig"

const ELEVEN: FallbackTtsInfo = {
  provider: "elevenlabs",
  speedSupported: true,
  speedMin: 0.7,
  speedMax: 1.2,
  speedDefault: 1.0,
}

describe("parseFallbackTtsInfo", () => {
  it("parses a supported-provider payload", () => {
    const parsed = parseFallbackTtsInfo({
      provider: "elevenlabs",
      speed_supported: true,
      speed_min: 0.7,
      speed_max: 1.2,
      speed_default: 1.0,
    })
    expect(parsed).toEqual(ELEVEN)
  })

  it("parses an unsupported-provider payload with null bounds", () => {
    const parsed = parseFallbackTtsInfo({
      provider: "mock",
      speed_supported: false,
      speed_min: null,
      speed_max: null,
      speed_default: null,
    })
    expect(parsed.speedSupported).toBe(false)
    expect(parsed.speedMin).toBeNull()
  })

  it.each([
    {},
    { provider: "x" },
    { provider: 1, speed_supported: true },
    { provider: "x", speed_supported: "yes" },
    { provider: "x", speed_supported: true, speed_min: "0.7" },
  ])("rejects an invalid payload %#", (payload) => {
    expect(() => parseFallbackTtsInfo(payload)).toThrow()
  })
})

describe("clampFallbackSpeed", () => {
  it("clamps to the reported range", () => {
    expect(clampFallbackSpeed(5, ELEVEN)).toBe(1.2)
    expect(clampFallbackSpeed(0.1, ELEVEN)).toBe(0.7)
    expect(clampFallbackSpeed(1.0, ELEVEN)).toBe(1.0)
  })

  it("does not assume one provider's range for another", () => {
    const google: FallbackTtsInfo = {
      provider: "google",
      speedSupported: true,
      speedMin: 0.25,
      speedMax: 4.0,
      speedDefault: 1.0,
    }
    expect(clampFallbackSpeed(3.5, google)).toBe(3.5) // valid for google, not eleven
    expect(clampFallbackSpeed(3.5, ELEVEN)).toBe(1.2)
  })

  it("falls back to default when the value is not finite", () => {
    expect(clampFallbackSpeed(Number.NaN, ELEVEN)).toBe(1.0)
  })

  it("returns the raw value when bounds are unavailable", () => {
    const noBounds: FallbackTtsInfo = {
      provider: "mock",
      speedSupported: false,
      speedMin: null,
      speedMax: null,
      speedDefault: null,
    }
    expect(clampFallbackSpeed(2.5, noBounds)).toBe(2.5)
  })
})
