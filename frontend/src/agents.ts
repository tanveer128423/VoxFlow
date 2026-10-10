// Persistent, customizable agent model for VoxFlow.
//
// Pure data + localStorage helpers (no React, no network) so the logic is
// deterministically unit-testable. Follows the versioned-key + defensive-parse
// pattern established in conversation.ts.

import type { RealtimeTurnDetection } from "./api/voiceApi"
import { isValidVariableName, type PromptVariable } from "./prompt"
import { clampTurnDetection } from "./realtimeConfig"

export const AGENTS_STORAGE_KEY = "voxflow.agents.v1"
export const SELECTED_AGENT_STORAGE_KEY = "voxflow.selectedAgentId.v1"
export const AGENT_SCHEMA_VERSION = 1

export const DEFAULT_AGENT_NAME = "Default"

// Settings scope:
// - promptTemplate / promptVariables apply to BOTH live Realtime and fallback.
// - voice / turnDetection apply to live Realtime ONLY (fallback TTS voice/VAD
//   stay backend-configured). null means "use the backend default".
export type AgentConfig = {
  promptTemplate: string
  promptVariables: PromptVariable[]
  voice: string | null
  turnDetection: RealtimeTurnDetection | null
  // Fallback TTS speed override (provider-native value). null = use the
  // backend environment/provider default. Applies to fallback TTS only.
  fallbackSpeed: number | null
}

export type Agent = {
  id: string
  name: string
  description: string
  config: AgentConfig
  createdAt: string
  updatedAt: string
  schemaVersion: number
}

export function createAgentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function nowIso(): string {
  return new Date().toISOString()
}

export function defaultAgentConfig(): AgentConfig {
  // Empty config => buildRealtimeConfig(...) returns {}, i.e. current behavior.
  return {
    promptTemplate: "",
    promptVariables: [],
    voice: null,
    turnDetection: null,
    fallbackSpeed: null,
  }
}

export function createAgent(name?: string, description = ""): Agent {
  const timestamp = nowIso()
  return {
    id: createAgentId(),
    name: (name ?? "Untitled agent").trim() || "Untitled agent",
    description,
    config: defaultAgentConfig(),
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: AGENT_SCHEMA_VERSION,
  }
}

// --- Defensive parsing / migration -------------------------------------------

function parsePromptVariable(value: unknown): PromptVariable | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== "string" || typeof record.value !== "string") {
    return null
  }
  const id = typeof record.id === "string" && record.id ? record.id : createAgentId()
  return { id, name: record.name, value: record.value }
}

function parseTurnDetection(value: unknown): RealtimeTurnDetection | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (
    typeof record.threshold !== "number" ||
    typeof record.prefix_padding_ms !== "number" ||
    typeof record.silence_duration_ms !== "number"
  ) {
    return null
  }
  // Clamp to supported ranges so stored/edited values can never exceed bounds.
  return clampTurnDetection({
    threshold: record.threshold,
    prefix_padding_ms: record.prefix_padding_ms,
    silence_duration_ms: record.silence_duration_ms,
  })
}

function parseAgentConfig(value: unknown): AgentConfig {
  const base = defaultAgentConfig()
  if (!value || typeof value !== "object") return base
  const record = value as Record<string, unknown>
  return {
    promptTemplate:
      typeof record.promptTemplate === "string" ? record.promptTemplate : "",
    promptVariables: Array.isArray(record.promptVariables)
      ? record.promptVariables
          .map(parsePromptVariable)
          .filter((variable): variable is PromptVariable => variable !== null)
      : [],
    voice: typeof record.voice === "string" ? record.voice : null,
    turnDetection: parseTurnDetection(record.turnDetection),
    fallbackSpeed:
      typeof record.fallbackSpeed === "number" ? record.fallbackSpeed : null,
  }
}

// Parse a single stored agent, repairing missing/invalid fields. Returns null
// only when there is nothing usable (not an object).
export function parseAgent(value: unknown): Agent | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const timestamp = nowIso()
  const id =
    typeof record.id === "string" && record.id ? record.id : createAgentId()
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name
      : "Untitled agent"
  return {
    id,
    name,
    description:
      typeof record.description === "string" ? record.description : "",
    config: parseAgentConfig(record.config),
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : timestamp,
    updatedAt:
      typeof record.updatedAt === "string" ? record.updatedAt : timestamp,
    schemaVersion:
      typeof record.schemaVersion === "number"
        ? record.schemaVersion
        : AGENT_SCHEMA_VERSION,
  }
}

// Ensure no two agents share an id (regenerate duplicates deterministically
// after the first occurrence).
function dedupeIds(agents: Agent[]): Agent[] {
  const seen = new Set<string>()
  return agents.map((agent) => {
    if (seen.has(agent.id)) {
      const fresh = { ...agent, id: createAgentId() }
      seen.add(fresh.id)
      return fresh
    }
    seen.add(agent.id)
    return agent
  })
}

// --- Storage ------------------------------------------------------------------

export function loadAgents(): Agent[] {
  try {
    const raw = localStorage.getItem(AGENTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const agents = parsed
      .map(parseAgent)
      .filter((agent): agent is Agent => agent !== null)
    return dedupeIds(agents)
  } catch {
    return []
  }
}

export function saveAgents(agents: Agent[]): void {
  try {
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(agents))
  } catch {
    // Storage may be unavailable or full; the app remains usable in-memory.
  }
}

export function loadSelectedAgentId(): string | null {
  try {
    return localStorage.getItem(SELECTED_AGENT_STORAGE_KEY)
  } catch {
    return null
  }
}

export function saveSelectedAgentId(id: string): void {
  try {
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, id)
  } catch {
    // Non-fatal.
  }
}

// --- Pure CRUD operations (return new arrays; never mutate inputs) ------------

// Guarantee a non-empty, valid agent list with a Default agent when needed.
export function ensureAgents(agents: Agent[]): Agent[] {
  if (agents.length > 0) return agents
  return [createAgent(DEFAULT_AGENT_NAME)]
}

export function addAgent(agents: Agent[], agent: Agent): Agent[] {
  return [...agents, agent]
}

// Store the name exactly as typed so a controlled input preserves spaces while
// the user is editing (e.g. typing "Sales Team" left to right). Final trimming
// and the empty-name fallback happen at a boundary via normalizeAgentName.
export function renameAgent(
  agents: Agent[],
  id: string,
  name: string,
): Agent[] {
  return agents.map((agent) =>
    agent.id === id ? { ...agent, name, updatedAt: nowIso() } : agent,
  )
}

// Normalize a single agent's name at a boundary (e.g. input blur): trim
// surrounding whitespace and fall back to "Untitled agent" when empty. No-op
// (and no updatedAt churn) when the name is already normalized.
export function normalizeAgentName(agents: Agent[], id: string): Agent[] {
  return agents.map((agent) => {
    if (agent.id !== id) return agent
    const normalized = agent.name.trim() || "Untitled agent"
    if (normalized === agent.name) return agent
    return { ...agent, name: normalized, updatedAt: nowIso() }
  })
}

export function updateAgentDescription(
  agents: Agent[],
  id: string,
  description: string,
): Agent[] {
  return agents.map((agent) =>
    agent.id === id
      ? { ...agent, description, updatedAt: nowIso() }
      : agent,
  )
}

export function updateAgentConfig(
  agents: Agent[],
  id: string,
  config: AgentConfig,
): Agent[] {
  return agents.map((agent) =>
    agent.id === id ? { ...agent, config, updatedAt: nowIso() } : agent,
  )
}

export function duplicateAgent(agents: Agent[], id: string): Agent[] {
  const source = agents.find((agent) => agent.id === id)
  if (!source) return agents
  const timestamp = nowIso()
  const copy: Agent = {
    ...source,
    id: createAgentId(),
    name: `${source.name} (copy)`,
    // Deep-copy the config so the duplicate cannot share variable references.
    config: {
      ...source.config,
      promptVariables: source.config.promptVariables.map((variable) => ({
        ...variable,
      })),
      turnDetection: source.config.turnDetection
        ? { ...source.config.turnDetection }
        : null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const index = agents.findIndex((agent) => agent.id === id)
  return [...agents.slice(0, index + 1), copy, ...agents.slice(index + 1)]
}

// Delete an agent; never returns an empty list (recreates Default if needed).
export function deleteAgent(agents: Agent[], id: string): Agent[] {
  return ensureAgents(agents.filter((agent) => agent.id !== id))
}

// Resolve which agent should be selected given a desired id and the list.
export function resolveSelectedAgentId(
  agents: Agent[],
  desiredId: string | null,
): string {
  if (desiredId && agents.some((agent) => agent.id === desiredId)) {
    return desiredId
  }
  return agents[0]?.id ?? ""
}

export function getAgentById(agents: Agent[], id: string): Agent | undefined {
  return agents.find((agent) => agent.id === id)
}

// Does the variable list contain any invalid names (for UI feedback / parity
// with the existing prompt validation)? Kept here as a small reusable check.
export function hasInvalidVariableNames(config: AgentConfig): boolean {
  return config.promptVariables.some(
    (variable) =>
      variable.name.trim() !== "" && !isValidVariableName(variable.name),
  )
}
