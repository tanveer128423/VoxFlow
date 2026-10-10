export type TurnTelemetry = {
  id: string
  status: "complete" | "interrupted"
  userSpeechToResponseMs?: number
  // Measured from the Realtime response.created event (response started).
  eouToResponseStartedMs?: number
  responseStartedToTranscriptMs?: number
  firstAssistantTranscriptMs?: number
  firstAssistantAudioMs?: number
  totalResponseMs?: number
}

export type TelemetrySnapshot = {
  sessionSetupMs?: number
  turns: TurnTelemetry[]
  errorCount: number
}

const MAX_RECENT_TURNS = 5

export class FrontendTelemetry {
  private sessionSetupStartedAt: number | null = null
  private activeTurn: {
    id: string
    speechStartedAt: number
    speechStoppedAt?: number
    responseStartedAt?: number
    firstAssistantTranscriptAt?: number
    firstAssistantAudioAt?: number
    responseId?: string
    ignoreNextInterruptedResponse: boolean
  } | null = null
  private snapshot: TelemetrySnapshot = { turns: [], errorCount: 0 }
  private listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): TelemetrySnapshot => this.snapshot

  startSessionSetup(): void {
    this.sessionSetupStartedAt = performance.now()
  }

  completeSessionSetup(): void {
    if (this.sessionSetupStartedAt === null) return
    this.snapshot = {
      ...this.snapshot,
      sessionSetupMs: Math.max(0, performance.now() - this.sessionSetupStartedAt),
    }
    this.sessionSetupStartedAt = null
    this.notify()
  }

  startTurn(interruptingResponse = false): void {
    this.activeTurn = {
      id: `${Date.now()}-${Math.random()}`,
      speechStartedAt: performance.now(),
      ignoreNextInterruptedResponse: interruptingResponse,
    }
  }

  markUserSpeechStopped(): void {
    if (!this.activeTurn || this.activeTurn.speechStoppedAt !== undefined) return
    this.activeTurn.speechStoppedAt = performance.now()
  }

  markAssistantTranscript(responseId: string): void {
    if (
      !this.activeTurn ||
      this.activeTurn.responseId !== responseId ||
      this.activeTurn.firstAssistantTranscriptAt !== undefined
    ) return
    this.activeTurn.firstAssistantTranscriptAt = performance.now()
  }

  beginResponse(responseId: string): void {
    if (!this.activeTurn) return
    this.activeTurn.responseId = responseId
    // Capture the genuine "response started" boundary (Realtime response.created)
    // once per turn; later response.created events for the same turn are ignored.
    if (this.activeTurn.responseStartedAt === undefined) {
      this.activeTurn.responseStartedAt = performance.now()
    }
  }

  markAssistantAudio(responseId: string): void {
    if (
      !this.activeTurn ||
      this.activeTurn.responseId !== responseId ||
      this.activeTurn.firstAssistantAudioAt !== undefined
    ) return
    this.activeTurn.firstAssistantAudioAt = performance.now()
  }

  finishTurn(responseId: string, status: TurnTelemetry["status"]): void {
    if (!this.activeTurn || this.activeTurn.responseId !== responseId) return
    if (status === "interrupted" && this.activeTurn.ignoreNextInterruptedResponse) {
      this.activeTurn.ignoreNextInterruptedResponse = false
      return
    }
    const finishedAt = performance.now()
    const {
      speechStartedAt,
      speechStoppedAt,
      responseStartedAt,
      firstAssistantTranscriptAt,
      firstAssistantAudioAt,
    } = this.activeTurn
    const turn: TurnTelemetry = {
      id: this.activeTurn.id,
      status,
      userSpeechToResponseMs: Math.max(0, finishedAt - speechStartedAt),
      ...(speechStoppedAt !== undefined &&
        responseStartedAt !== undefined &&
        responseStartedAt >= speechStoppedAt && {
        eouToResponseStartedMs: Math.max(0, responseStartedAt - speechStoppedAt),
      }),
      ...(responseStartedAt !== undefined &&
        firstAssistantTranscriptAt !== undefined &&
        firstAssistantTranscriptAt >= responseStartedAt && {
        responseStartedToTranscriptMs: Math.max(0, firstAssistantTranscriptAt - responseStartedAt),
      }),
      ...(speechStoppedAt !== undefined &&
        firstAssistantTranscriptAt !== undefined &&
        firstAssistantTranscriptAt >= speechStoppedAt && {
        firstAssistantTranscriptMs: Math.max(0, firstAssistantTranscriptAt - speechStoppedAt),
      }),
      ...(speechStoppedAt !== undefined &&
        firstAssistantAudioAt !== undefined &&
        firstAssistantAudioAt >= speechStoppedAt && {
        firstAssistantAudioMs: Math.max(0, firstAssistantAudioAt - speechStoppedAt),
      }),
      ...(status === "complete" && {
        totalResponseMs: Math.max(0, finishedAt - speechStartedAt),
      }),
    }
    this.snapshot = {
      ...this.snapshot,
      turns: [...this.snapshot.turns, turn].slice(-MAX_RECENT_TURNS),
    }
    this.activeTurn = null
    this.notify()
  }

  recordError(): void {
    this.snapshot = { ...this.snapshot, errorCount: this.snapshot.errorCount + 1 }
    this.notify()
  }

  reset(): void {
    this.snapshot = { turns: [], errorCount: 0 }
    this.activeTurn = null
    this.sessionSetupStartedAt = null
    this.notify()
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }
}

export function p50(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

export type TelemetrySummary = {
  // EOU = end of user utterance (server VAD speech_stopped). All values below
  // are measured from genuine Realtime event timestamps and real audio playback
  // boundaries captured locally; they are not isolated STT / LLM / TTS stage
  // timings (the live Realtime path does not expose those).
  p50EouToResponseStartedMs?: number
  p50ResponseStartedToTranscriptMs?: number
  p50EouToTranscriptMs?: number
  p50EouToAudioMs?: number
  // Includes the user's own speaking time (measured from speech start).
  p50SpeechStartToDoneMs?: number
  completeCount: number
}

function collect(
  turns: TurnTelemetry[],
  selector: (turn: TurnTelemetry) => number | undefined,
): number[] {
  return turns.flatMap((turn) => {
    const value = selector(turn)
    return value === undefined ? [] : [value]
  })
}

// Actual, backend-measured per-stage latency from turn-based (fallback) turns.
// The live Realtime API does not expose separable STT/LLM/TTS timings, so these
// are populated only from real turn-based samples and are never fabricated from
// totals or proxies.
export type StageTimingSample = {
  stt_ms: number | null
  llm_ms: number | null
  tts_ms: number | null
}

export type StageLatencySummary = {
  p50SttMs?: number
  p50LlmMs?: number
  p50TtsMs?: number
  // Number of turn-based turns that contributed any stage timing.
  sampleCount: number
}

export function summarizeStageTimings(
  samples: StageTimingSample[],
): StageLatencySummary {
  const stt = samples.flatMap((s) => (s.stt_ms === null ? [] : [s.stt_ms]))
  const llm = samples.flatMap((s) => (s.llm_ms === null ? [] : [s.llm_ms]))
  const tts = samples.flatMap((s) => (s.tts_ms === null ? [] : [s.tts_ms]))
  return {
    p50SttMs: p50(stt),
    p50LlmMs: p50(llm),
    p50TtsMs: p50(tts),
    sampleCount: samples.length,
  }
}

export function summarizeTurns(turns: TurnTelemetry[]): TelemetrySummary {
  const completeTurns = turns.filter((turn) => turn.status === "complete")
  return {
    p50EouToResponseStartedMs: p50(collect(turns, (t) => t.eouToResponseStartedMs)),
    p50ResponseStartedToTranscriptMs: p50(
      collect(turns, (t) => t.responseStartedToTranscriptMs),
    ),
    p50EouToTranscriptMs: p50(collect(turns, (t) => t.firstAssistantTranscriptMs)),
    p50EouToAudioMs: p50(collect(turns, (t) => t.firstAssistantAudioMs)),
    p50SpeechStartToDoneMs: p50(
      collect(completeTurns, (t) => t.totalResponseMs),
    ),
    completeCount: completeTurns.length,
  }
}
