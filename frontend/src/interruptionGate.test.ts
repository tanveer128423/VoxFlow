import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { InterruptionGate } from "./interruptionGate"
import { INTERRUPTION_SAFETY_TIMEOUT_MS } from "./wordGate"

describe("InterruptionGate", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("D1: armed-then-cleared (brief speech) does NOT force an interruption", () => {
    const onForce = vi.fn()
    const gate = new InterruptionGate(onForce)
    gate.arm()
    expect(gate.isArmed).toBe(true)
    // User stops speaking before the timeout -> clear cancels the safety timer.
    gate.clear()
    vi.advanceTimersByTime(INTERRUPTION_SAFETY_TIMEOUT_MS * 2)
    expect(onForce).not.toHaveBeenCalled()
    expect(gate.isArmed).toBe(false)
  })

  it("D1: sustained speech past the timeout forces exactly one interruption", () => {
    const onForce = vi.fn()
    const gate = new InterruptionGate(onForce)
    gate.arm()
    vi.advanceTimersByTime(INTERRUPTION_SAFETY_TIMEOUT_MS)
    expect(onForce).toHaveBeenCalledTimes(1)
    expect(gate.isArmed).toBe(false)
  })

  it("is idempotent: re-arming while pending does not schedule a second timer", () => {
    const onForce = vi.fn()
    const gate = new InterruptionGate(onForce)
    gate.arm()
    gate.arm()
    gate.arm()
    vi.advanceTimersByTime(INTERRUPTION_SAFETY_TIMEOUT_MS)
    expect(onForce).toHaveBeenCalledTimes(1)
  })

  it("clear() is safe when nothing is armed", () => {
    const onForce = vi.fn()
    const gate = new InterruptionGate(onForce)
    expect(() => gate.clear()).not.toThrow()
    expect(gate.isArmed).toBe(false)
  })

  it("respects an injected timeout and timer API", () => {
    const onForce = vi.fn()
    const set = vi.fn(setTimeout)
    const clear = vi.fn(clearTimeout)
    const gate = new InterruptionGate(onForce, 500, { set, clear })
    gate.arm()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0][1]).toBe(500)
    gate.clear()
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
