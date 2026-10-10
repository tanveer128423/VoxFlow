import { describe, expect, it } from "vitest"

import {
  p50,
  summarizeStageTimings,
  summarizeTurns,
  type TurnTelemetry,
} from "./telemetry"

function turn(partial: Partial<TurnTelemetry>): TurnTelemetry {
  return {
    id: Math.random().toString(),
    status: "complete",
    ...partial,
  }
}

describe("p50", () => {
  it("returns undefined for an empty set", () => {
    expect(p50([])).toBeUndefined()
  })

  it("returns the middle value for an odd-length set", () => {
    expect(p50([30, 10, 20])).toBe(20)
  })

  it("averages the two middle values for an even-length set", () => {
    expect(p50([10, 20, 30, 40])).toBe(25)
  })
})

describe("summarizeTurns", () => {
  it("computes EOU-anchored p50s and counts complete turns", () => {
    const summary = summarizeTurns([
      turn({
        status: "complete",
        firstAssistantTranscriptMs: 100,
        firstAssistantAudioMs: 200,
        totalResponseMs: 1000,
      }),
      turn({
        status: "complete",
        firstAssistantTranscriptMs: 300,
        firstAssistantAudioMs: 400,
        totalResponseMs: 3000,
      }),
    ])
    expect(summary.p50EouToTranscriptMs).toBe(200)
    expect(summary.p50EouToAudioMs).toBe(300)
    expect(summary.p50SpeechStartToDoneMs).toBe(2000)
    expect(summary.completeCount).toBe(2)
  })

  it("excludes interrupted turns from the total-response p50", () => {
    const summary = summarizeTurns([
      turn({ status: "complete", totalResponseMs: 1000 }),
      turn({ status: "interrupted", totalResponseMs: 50 }),
    ])
    expect(summary.p50SpeechStartToDoneMs).toBe(1000)
    expect(summary.completeCount).toBe(1)
  })

  it("omits metrics that were never measured", () => {
    const summary = summarizeTurns([turn({ status: "interrupted" })])
    expect(summary.p50EouToResponseStartedMs).toBeUndefined()
    expect(summary.p50ResponseStartedToTranscriptMs).toBeUndefined()
    expect(summary.p50EouToTranscriptMs).toBeUndefined()
    expect(summary.p50EouToAudioMs).toBeUndefined()
    expect(summary.p50SpeechStartToDoneMs).toBeUndefined()
    expect(summary.completeCount).toBe(0)
  })

  it("computes p50s for the measured Live-mode stage boundaries", () => {
    const summary = summarizeTurns([
      turn({
        status: "complete",
        eouToResponseStartedMs: 120,
        responseStartedToTranscriptMs: 80,
      }),
      turn({
        status: "interrupted",
        eouToResponseStartedMs: 220,
        responseStartedToTranscriptMs: 180,
      }),
    ])
    // Both complete and interrupted turns contribute genuine boundary samples.
    expect(summary.p50EouToResponseStartedMs).toBe(170)
    expect(summary.p50ResponseStartedToTranscriptMs).toBe(130)
  })
})

describe("summarizeStageTimings", () => {
  it("returns no p50 values and zero samples for empty input", () => {
    const summary = summarizeStageTimings([])
    expect(summary.p50SttMs).toBeUndefined()
    expect(summary.p50LlmMs).toBeUndefined()
    expect(summary.p50TtsMs).toBeUndefined()
    expect(summary.sampleCount).toBe(0)
  })

  it("computes p50 from actual stage timings", () => {
    const summary = summarizeStageTimings([
      { stt_ms: 100, llm_ms: 300, tts_ms: 200 },
      { stt_ms: 200, llm_ms: 500, tts_ms: 400 },
      { stt_ms: 300, llm_ms: 700, tts_ms: 600 },
    ])
    expect(summary.p50SttMs).toBe(200)
    expect(summary.p50LlmMs).toBe(500)
    expect(summary.p50TtsMs).toBe(400)
    expect(summary.sampleCount).toBe(3)
  })

  it("excludes null stage values independently per stage", () => {
    const summary = summarizeStageTimings([
      { stt_ms: 100, llm_ms: 300, tts_ms: null },
      { stt_ms: 200, llm_ms: null, tts_ms: 400 },
    ])
    // TTS has a single actual sample (400); LLM has a single actual sample (300).
    expect(summary.p50SttMs).toBe(150)
    expect(summary.p50LlmMs).toBe(300)
    expect(summary.p50TtsMs).toBe(400)
    // Both turns still count as samples even with partial stage failures.
    expect(summary.sampleCount).toBe(2)
  })

  it("leaves a fully failed stage undefined while keeping others", () => {
    const summary = summarizeStageTimings([
      { stt_ms: 120, llm_ms: 240, tts_ms: null },
      { stt_ms: 180, llm_ms: 360, tts_ms: null },
    ])
    expect(summary.p50SttMs).toBe(150)
    expect(summary.p50LlmMs).toBe(300)
    expect(summary.p50TtsMs).toBeUndefined()
    expect(summary.sampleCount).toBe(2)
  })
})
