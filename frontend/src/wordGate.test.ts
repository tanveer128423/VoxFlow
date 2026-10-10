import { describe, expect, it } from "vitest"

import { INTERRUPTION_SAFETY_TIMEOUT_MS, WordGate } from "./wordGate"

describe("WordGate counting", () => {
  it("counts whole whitespace-delimited words", () => {
    const gate = new WordGate()
    gate.reset("r1")
    gate.addDelta("Hello there ")
    expect(gate.wordCount).toBe(2)
  })

  it("does not double-count a word split across deltas", () => {
    const gate = new WordGate()
    gate.reset("r1")
    gate.addDelta("Hel")
    expect(gate.wordCount).toBe(0) // trailing partial not yet committed
    gate.addDelta("lo world ")
    expect(gate.wordCount).toBe(2) // "Hello" + "world"
  })

  it("buffers an unterminated trailing word until completed", () => {
    const gate = new WordGate()
    gate.reset()
    gate.addDelta("one two three")
    expect(gate.wordCount).toBe(2) // "three" still buffered
    gate.flush()
    expect(gate.wordCount).toBe(3)
  })

  it("handles punctuation and collapsed whitespace", () => {
    const gate = new WordGate()
    gate.reset()
    gate.addDelta("Well,   this  is   fine. ")
    expect(gate.wordCount).toBe(4)
  })

  it("ignores empty and whitespace-only deltas", () => {
    const gate = new WordGate()
    gate.reset()
    gate.addDelta("")
    gate.addDelta("   ")
    expect(gate.wordCount).toBe(0)
  })
})

describe("WordGate.canInterrupt threshold", () => {
  it("is always interruptible at threshold 0 (default)", () => {
    const gate = new WordGate()
    gate.reset()
    expect(gate.canInterrupt(0)).toBe(true)
  })

  it("opens only once the threshold is reached", () => {
    const gate = new WordGate()
    gate.reset()
    gate.addDelta("one two ")
    expect(gate.canInterrupt(3)).toBe(false)
    gate.addDelta("three ")
    expect(gate.canInterrupt(3)).toBe(true)
    gate.addDelta("four ")
    expect(gate.canInterrupt(3)).toBe(true)
  })

  it("treats negative/non-finite thresholds as 0", () => {
    const gate = new WordGate()
    gate.reset()
    expect(gate.canInterrupt(-5)).toBe(true)
    expect(gate.canInterrupt(Number.NaN)).toBe(true)
  })
})

describe("WordGate reset / recovery", () => {
  it("resets count and partial for a new response", () => {
    const gate = new WordGate()
    gate.reset("r1")
    gate.addDelta("some words here")
    gate.reset("r2")
    expect(gate.wordCount).toBe(0)
    expect(gate.activeResponseId).toBe("r2")
    expect(gate.canInterrupt(2)).toBe(false)
  })

  it("exposes a non-zero safety timeout so users are never trapped", () => {
    expect(INTERRUPTION_SAFETY_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
