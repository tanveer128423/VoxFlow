import { describe, expect, it } from "vitest"

import {
  DEFAULT_MIC_PROCESSING,
  DEFAULT_VOLUME,
  applyVolume,
  buildAudioConstraints,
  clampInterruptMinWords,
  clampMinResponseDelayMs,
  clampVolume,
  computePlaybackDelayMs,
  normalizeMicProcessing,
} from "./audioConfig"

describe("clampVolume", () => {
  it("keeps in-range values", () => {
    expect(clampVolume(0)).toBe(0)
    expect(clampVolume(0.5)).toBe(0.5)
    expect(clampVolume(1)).toBe(1)
  })
  it("clamps out-of-range values", () => {
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(2)).toBe(1)
  })
  it("falls back to default on non-finite input", () => {
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_VOLUME)
    expect(clampVolume(Infinity)).toBe(DEFAULT_VOLUME)
  })
})

describe("clampMinResponseDelayMs", () => {
  it("rounds and clamps to 0..5000", () => {
    expect(clampMinResponseDelayMs(0)).toBe(0)
    expect(clampMinResponseDelayMs(250.6)).toBe(251)
    expect(clampMinResponseDelayMs(-10)).toBe(0)
    expect(clampMinResponseDelayMs(99999)).toBe(5000)
  })
  it("defaults to 0 on non-finite input", () => {
    expect(clampMinResponseDelayMs(Number.NaN)).toBe(0)
  })
})

describe("clampInterruptMinWords", () => {
  it("rounds and clamps to 0..100", () => {
    expect(clampInterruptMinWords(0)).toBe(0)
    expect(clampInterruptMinWords(3.4)).toBe(3)
    expect(clampInterruptMinWords(-5)).toBe(0)
    expect(clampInterruptMinWords(1000)).toBe(100)
  })
})

describe("normalizeMicProcessing", () => {
  it("returns all-true defaults for missing/invalid input", () => {
    expect(normalizeMicProcessing(null)).toEqual(DEFAULT_MIC_PROCESSING)
    expect(normalizeMicProcessing("x")).toEqual(DEFAULT_MIC_PROCESSING)
    expect(normalizeMicProcessing({})).toEqual(DEFAULT_MIC_PROCESSING)
  })
  it("preserves explicit booleans and defaults non-booleans to true", () => {
    expect(
      normalizeMicProcessing({
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: "nope",
      }),
    ).toEqual({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    })
  })
})

describe("buildAudioConstraints", () => {
  it("maps each flag into getUserMedia audio constraints", () => {
    expect(
      buildAudioConstraints({
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      }),
    ).toEqual({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    })
  })
})

describe("applyVolume", () => {
  it("mutates the target's real volume field (not just UI state)", () => {
    const element = { volume: 1 }
    const applied = applyVolume(element, 0.3)
    expect(element.volume).toBe(0.3)
    expect(applied).toBe(0.3)
  })
  it("clamps before applying", () => {
    const element = { volume: 1 }
    applyVolume(element, 5)
    expect(element.volume).toBe(1)
  })
})

describe("computePlaybackDelayMs", () => {
  it("waits only the remaining time when audio is ready early", () => {
    // EOU at 1000, audio ready at 1200, min delay 1000 => play at 2000 => 800ms.
    expect(computePlaybackDelayMs(1000, 1200, 1000)).toBe(800)
  })
  it("adds no delay when audio is already late", () => {
    expect(computePlaybackDelayMs(1000, 2500, 1000)).toBe(0)
  })
  it("is zero when the minimum delay is zero (default)", () => {
    expect(computePlaybackDelayMs(1000, 1000, 0)).toBe(0)
  })
  it("treats negative minimum delay as zero", () => {
    expect(computePlaybackDelayMs(1000, 1000, -500)).toBe(0)
  })
  it("returns 0 on non-finite timestamps", () => {
    expect(computePlaybackDelayMs(Number.NaN, 1000, 1000)).toBe(0)
  })
})
