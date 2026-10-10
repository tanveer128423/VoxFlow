import { describe, expect, it } from "vitest"

import { p50, summarizeTurns, type TurnTelemetry } from "./telemetry"

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
    expect(summary.p50EouToTranscriptMs).toBeUndefined()
    expect(summary.p50EouToAudioMs).toBeUndefined()
    expect(summary.p50SpeechStartToDoneMs).toBeUndefined()
    expect(summary.completeCount).toBe(0)
  })
})
