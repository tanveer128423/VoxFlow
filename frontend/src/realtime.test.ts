import { describe, expect, it } from "vitest"

import { decideSpeechStart, isSupersedingResponse } from "./realtime"

// C1: detect when a new response begins while a previous one is still active.
describe("isSupersedingResponse", () => {
  it("is false when no response is active", () => {
    expect(isSupersedingResponse(false, null, "r2")).toBe(false)
    expect(isSupersedingResponse(false, "r1", "r2")).toBe(false)
  })

  it("is false for the normal sequential case (previous already finished)", () => {
    // After response.done the previous response is no longer active.
    expect(isSupersedingResponse(false, "r1", "r2")).toBe(false)
  })

  it("is false when the same response id is seen again", () => {
    expect(isSupersedingResponse(true, "r1", "r1")).toBe(false)
  })

  it("is true only when a different response starts while one is active", () => {
    expect(isSupersedingResponse(true, "r1", "r2")).toBe(true)
  })
})

// Hardening: repeated user speech during an already-interrupted response must
// not re-arm the safety timer or trigger redundant forced interruptions.
describe("decideSpeechStart", () => {
  it("proceeds when no response is active (starts a user turn)", () => {
    expect(decideSpeechStart(false, false, false)).toBe("proceed")
    expect(decideSpeechStart(false, true, false)).toBe("proceed")
  })

  it("proceeds (interrupt now) when active and the gate is open", () => {
    expect(decideSpeechStart(true, false, true)).toBe("proceed")
  })

  it("withholds when active, not yet interrupted, and the gate is closed", () => {
    expect(decideSpeechStart(true, false, false)).toBe("withhold")
  })

  it("ignores repeated bursts once the response is already interrupted", () => {
    // Regardless of the gate, an already-interrupted response ignores further
    // speech bursts (no re-arm, no redundant cancel/telemetry).
    expect(decideSpeechStart(true, true, false)).toBe("ignore")
    expect(decideSpeechStart(true, true, true)).toBe("ignore")
  })
})
