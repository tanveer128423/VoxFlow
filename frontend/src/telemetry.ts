export type TurnTelemetry = {
  id: string
  status: "complete" | "interrupted"
  userSpeechToResponseMs?: number
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
    if (this.activeTurn) this.activeTurn.responseId = responseId
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
      firstAssistantTranscriptAt,
      firstAssistantAudioAt,
    } = this.activeTurn
    const turn: TurnTelemetry = {
      id: this.activeTurn.id,
      status,
      userSpeechToResponseMs: Math.max(0, finishedAt - speechStartedAt),
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
