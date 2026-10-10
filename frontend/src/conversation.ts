export const CONVERSATION_STORAGE_KEY = "voxflow.conversations.v1"

export type FallbackTimings = {
  stt_ms: number | null
  llm_ms: number | null
  tts_ms: number | null
  total_ms: number | null
}

export type ConversationTurn = {
  id: string
  question: string
  answer: string
  createdAt: string
  audioUrl?: string
  ttsError?: string
  status?: "complete" | "interrupted"
  timings?: FallbackTimings
}

type PersistedTurn = Pick<
  ConversationTurn,
  "id" | "question" | "answer" | "createdAt" | "status"
>

function isPersistedTurn(value: unknown): value is PersistedTurn {
  if (!value || typeof value !== "object") return false
  const turn = value as Record<string, unknown>
  return (
    typeof turn.id === "string" &&
    typeof turn.question === "string" &&
    typeof turn.answer === "string" &&
    typeof turn.createdAt === "string"
    && (turn.status === undefined || turn.status === "complete" || turn.status === "interrupted")
  )
}

export function loadConversations(): ConversationTurn[] {
  try {
    const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPersistedTurn).map((turn) => ({ ...turn }))
  } catch {
    return []
  }
}

export function saveConversations(turns: ConversationTurn[]): void {
  try {
    const persisted: PersistedTurn[] = turns.map(
      ({ id, question, answer, createdAt, status }) => ({
        id,
        question,
        answer,
        createdAt,
        status,
      }),
    )
    localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // Storage can be unavailable or full; the live conversation remains usable.
  }
}

export function clearSavedConversations(): void {
  try {
    localStorage.removeItem(CONVERSATION_STORAGE_KEY)
  } catch {
    // Clearing the live state must not depend on storage availability.
  }
}

export function createConversationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}
