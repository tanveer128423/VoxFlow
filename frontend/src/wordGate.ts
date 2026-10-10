// Word-count interruption gate for the Live Realtime conversation.
//
// Counts assistant-spoken words from streamed transcript deltas so barge-in can
// be withheld until the assistant has spoken a configurable number of words.
// Pure logic (no DOM/network) so it is deterministically unit-testable.
//
// IMPORTANT APPROXIMATION: transcript delta events (`response.audio_transcript
// .delta`) are produced as the model generates text, which can run AHEAD of the
// audio the user actually hears. This gate therefore approximates "words heard"
// using "words generated". It is intentionally conservative (it counts only
// whole, whitespace-delimited words) and must be paired with a safety timeout in
// the caller so a user can never be trapped in an uninterruptible response.

// If the gate stays closed this long after the user starts speaking, the caller
// should force the interruption so the user is never trapped.
export const INTERRUPTION_SAFETY_TIMEOUT_MS = 2000

export class WordGate {
  private count = 0
  // Trailing non-whitespace carried across deltas so a word split across two
  // deltas ("hel" + "lo ") is counted once, not twice.
  private partial = ""
  private responseId: string | null = null

  // Begin counting for a new response (clears prior state).
  reset(responseId: string | null = null): void {
    this.count = 0
    this.partial = ""
    this.responseId = responseId
  }

  get wordCount(): number {
    return this.count
  }

  get activeResponseId(): string | null {
    return this.responseId
  }

  // Feed one transcript delta. Only whole words (followed by whitespace) are
  // committed; an unterminated trailing word is buffered until completed.
  addDelta(text: string): void {
    if (!text) return
    const combined = this.partial + text
    const endsWithWhitespace = /\s$/.test(combined)
    const tokens = combined.split(/\s+/).filter((token) => token.length > 0)
    if (tokens.length === 0) {
      // Whitespace-only delta: nothing to commit, drop any stale partial space.
      this.partial = endsWithWhitespace ? "" : this.partial
      return
    }
    if (endsWithWhitespace) {
      this.count += tokens.length
      this.partial = ""
    } else {
      this.count += tokens.length - 1
      this.partial = tokens[tokens.length - 1]
    }
  }

  // Commit any buffered trailing word as complete (e.g. on response end).
  flush(): void {
    if (this.partial.length > 0) {
      this.count += 1
      this.partial = ""
    }
  }

  // May the user interrupt now? True once the committed whole-word count has
  // reached the threshold. A threshold of 0 is always interruptible (the
  // default), preserving current always-interruptible behavior.
  canInterrupt(threshold: number): boolean {
    const effective =
      Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : 0
    return this.count >= effective
  }
}
