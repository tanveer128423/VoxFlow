// Safety controller for word-count-gated barge-in.
//
// When the word gate is closed (the assistant has not yet spoken the configured
// number of words), a user barge-in is withheld. To guarantee the user is never
// trapped in an uninterruptible response, a one-shot safety timeout forces the
// interruption IF the user keeps speaking past the timeout. A brief,
// sub-threshold utterance that stops before the timeout must NOT trigger a
// delayed interruption, so the controller is cleared on speech-stop.
//
// Pure and DOM-free: the timer functions are injectable so the brief-vs-
// sustained behavior is deterministically unit-testable with fake timers.

import { INTERRUPTION_SAFETY_TIMEOUT_MS } from "./wordGate"

type TimerApi = {
  set: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clear: (handle: ReturnType<typeof setTimeout>) => void
}

export class InterruptionGate {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onForceInterrupt: () => void,
    private readonly timeoutMs: number = INTERRUPTION_SAFETY_TIMEOUT_MS,
    private readonly timers: TimerApi = { set: setTimeout, clear: clearTimeout },
  ) {}

  // Arm a one-shot forced interruption. Idempotent: a second call while already
  // armed does nothing, so repeated speech bursts cannot schedule duplicate
  // forced interruptions.
  arm(): void {
    if (this.timer !== null) return
    this.timer = this.timers.set(() => {
      this.timer = null
      this.onForceInterrupt()
    }, this.timeoutMs)
  }

  // Cancel any pending forced interruption (user stopped speaking, response
  // ended/superseded, or the session closed).
  clear(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer)
      this.timer = null
    }
  }

  get isArmed(): boolean {
    return this.timer !== null
  }
}
