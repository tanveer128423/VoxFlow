import { describe, expect, it } from "vitest"

import type { RealtimeTurnDetection } from "./api/voiceApi"
import {
  buildRealtimeConfig,
  clampTurnDetection,
  parseVoiceOptions,
  type RealtimeVoiceOptions,
} from "./realtimeConfig"

const DEFAULT_VAD: RealtimeTurnDetection = {
  threshold: 0.65,
  prefix_padding_ms: 300,
  silence_duration_ms: 600,
}

const OPTIONS: RealtimeVoiceOptions = {
  voices: ["marin", "cedar", "verse"],
  defaultVoice: "marin",
  defaultTurnDetection: DEFAULT_VAD,
}

describe("clampTurnDetection", () => {
  it("clamps values to the supported ranges and rounds ms fields", () => {
    const clamped = clampTurnDetection({
      threshold: 5,
      prefix_padding_ms: -100,
      silence_duration_ms: 99999,
    })
    expect(clamped).toEqual({
      threshold: 1,
      prefix_padding_ms: 0,
      silence_duration_ms: 5000,
    })
  })

  it("rounds fractional millisecond inputs", () => {
    const clamped = clampTurnDetection({
      threshold: 0.4,
      prefix_padding_ms: 150.7,
      silence_duration_ms: 620.2,
    })
    expect(clamped.prefix_padding_ms).toBe(151)
    expect(clamped.silence_duration_ms).toBe(620)
    expect(clamped.threshold).toBe(0.4)
  })
})

describe("buildRealtimeConfig", () => {
  it("omits everything when settings equal defaults (preserves behavior)", () => {
    expect(
      buildRealtimeConfig({
        instructions: "",
        voice: "marin",
        turnDetection: DEFAULT_VAD,
        options: OPTIONS,
      }),
    ).toEqual({})
  })

  it("includes a non-default voice", () => {
    const config = buildRealtimeConfig({
      voice: "cedar",
      options: OPTIONS,
    })
    expect(config.voice).toBe("cedar")
  })

  it("includes clamped turn_detection only when it differs from default", () => {
    const config = buildRealtimeConfig({
      turnDetection: { ...DEFAULT_VAD, threshold: 0.4 },
      options: OPTIONS,
    })
    expect(config.turn_detection).toEqual({
      threshold: 0.4,
      prefix_padding_ms: 300,
      silence_duration_ms: 600,
    })
  })

  it("includes trimmed instructions when present", () => {
    const config = buildRealtimeConfig({
      instructions: "  Be terse.  ",
      voice: "marin",
      turnDetection: DEFAULT_VAD,
      options: OPTIONS,
    })
    expect(config.instructions).toBe("Be terse.")
    expect(config.voice).toBeUndefined()
    expect(config.turn_detection).toBeUndefined()
  })

  it("clamps out-of-range VAD before sending", () => {
    const config = buildRealtimeConfig({
      turnDetection: {
        threshold: 2,
        prefix_padding_ms: 9999,
        silence_duration_ms: -5,
      },
      options: OPTIONS,
    })
    expect(config.turn_detection).toEqual({
      threshold: 1,
      prefix_padding_ms: 2000,
      silence_duration_ms: 0,
    })
  })
})

describe("parseVoiceOptions", () => {
  it("accepts a well-formed payload", () => {
    const parsed = parseVoiceOptions({
      voices: ["marin", "cedar"],
      default_voice: "marin",
      default_turn_detection: DEFAULT_VAD,
    })
    expect(parsed.voices).toEqual(["marin", "cedar"])
    expect(parsed.defaultVoice).toBe("marin")
    expect(parsed.defaultTurnDetection).toEqual(DEFAULT_VAD)
  })

  it.each([
    {},
    { voices: [], default_voice: "marin", default_turn_detection: DEFAULT_VAD },
    { voices: [1], default_voice: "marin", default_turn_detection: DEFAULT_VAD },
    { voices: ["marin"], default_voice: 5, default_turn_detection: DEFAULT_VAD },
    { voices: ["marin"], default_voice: "marin", default_turn_detection: {} },
  ])("rejects an invalid payload %#", (payload) => {
    expect(() => parseVoiceOptions(payload)).toThrow()
  })
})
