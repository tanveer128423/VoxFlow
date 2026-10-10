import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildRealtimeConfig } from "./realtimeConfig"
import {
  AGENTS_STORAGE_KEY,
  SELECTED_AGENT_STORAGE_KEY,
  addAgent,
  createAgent,
  defaultAgentConfig,
  deleteAgent,
  duplicateAgent,
  ensureAgents,
  getAgentById,
  loadAgents,
  loadSelectedAgentId,
  parseAgent,
  normalizeAgentName,
  renameAgent,
  resolveSelectedAgentId,
  saveAgents,
  saveSelectedAgentId,
  updateAgentConfig,
  updateAgentDescription,
  type Agent,
} from "./agents"

// Minimal in-memory localStorage for deterministic storage tests.
function installMemoryStorage(): void {
  const store = new Map<string, string>()
  const mock: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  }
  vi.stubGlobal("localStorage", mock)
}

beforeEach(() => installMemoryStorage())
afterEach(() => vi.unstubAllGlobals())

describe("createAgent / defaults", () => {
  it("creates a default agent whose config preserves current behavior", () => {
    const agent = createAgent("Default")
    expect(agent.config).toEqual(defaultAgentConfig())
    // Empty config must produce an empty realtime config (no overrides).
    expect(
      buildRealtimeConfig({
        instructions: agent.config.promptTemplate,
        voice: agent.config.voice ?? undefined,
        turnDetection: agent.config.turnDetection ?? undefined,
      }),
    ).toEqual({})
  })

  it("assigns unique ids", () => {
    expect(createAgent().id).not.toBe(createAgent().id)
  })
})

describe("fallbackSpeed (M9)", () => {
  it("defaults to null so behavior is unchanged", () => {
    expect(createAgent("A").config.fallbackSpeed).toBeNull()
    expect(defaultAgentConfig().fallbackSpeed).toBeNull()
  })

  it("persists and reloads a configured speed", () => {
    const base = [createAgent("A")]
    const withSpeed = updateAgentConfig(base, base[0].id, {
      ...base[0].config,
      fallbackSpeed: 1.1,
    })
    saveAgents(withSpeed)
    expect(loadAgents()[0].config.fallbackSpeed).toBe(1.1)
  })

  it("migrates missing or invalid stored values to null", () => {
    expect(parseAgent({ name: "A" })!.config.fallbackSpeed).toBeNull()
    expect(
      parseAgent({ name: "A", config: { fallbackSpeed: "fast" } })!.config
        .fallbackSpeed,
    ).toBeNull()
    expect(
      parseAgent({ name: "A", config: { fallbackSpeed: 0.9 } })!.config
        .fallbackSpeed,
    ).toBe(0.9)
  })

  it("copies the speed when duplicating", () => {
    const base = [createAgent("A")]
    const withSpeed = updateAgentConfig(base, base[0].id, {
      ...base[0].config,
      fallbackSpeed: 1.2,
    })
    const duplicated = duplicateAgent(withSpeed, base[0].id)
    expect(duplicated[1].config.fallbackSpeed).toBe(1.2)
  })
})

describe("CRUD operations", () => {
  it("renames an agent and bumps updatedAt", () => {
    const agents = [createAgent("A")]
    const renamed = renameAgent(agents, agents[0].id, "Renamed")
    expect(renamed[0].name).toBe("Renamed")
    expect(agents[0].name).toBe("A") // original not mutated
  })

  it("preserves the raw name while typing, including spaces", () => {
    const agents = [createAgent("A")]
    // Simulate left-to-right typing of a multi-word name; trailing spaces that
    // appear mid-type must survive (the keystroke-trim bug ate them before).
    expect(renameAgent(agents, agents[0].id, "Sales ")[0].name).toBe("Sales ")
    expect(renameAgent(agents, agents[0].id, "Sales Team")[0].name).toBe(
      "Sales Team",
    )
    expect(renameAgent(agents, agents[0].id, "")[0].name).toBe("")
  })

  it("only renames the targeted agent", () => {
    const a = createAgent("A")
    const b = createAgent("B")
    const renamed = renameAgent([a, b], a.id, "Sales Team")
    expect(renamed[0].name).toBe("Sales Team")
    expect(renamed[1].name).toBe("B")
  })

  it("normalizes names at the boundary (trim + empty fallback)", () => {
    const agents = [createAgent("A")]
    const withSpaces = renameAgent(agents, agents[0].id, "  Sales Team  ")
    expect(normalizeAgentName(withSpaces, agents[0].id)[0].name).toBe(
      "Sales Team",
    )

    const blank = renameAgent(agents, agents[0].id, "   ")
    expect(normalizeAgentName(blank, agents[0].id)[0].name).toBe(
      "Untitled agent",
    )

    const empty = renameAgent(agents, agents[0].id, "")
    expect(normalizeAgentName(empty, agents[0].id)[0].name).toBe(
      "Untitled agent",
    )
  })

  it("normalization is a no-op for an already-clean name", () => {
    const agents = [createAgent("Sales Team")]
    const normalized = normalizeAgentName(agents, agents[0].id)
    expect(normalized[0]).toBe(agents[0]) // unchanged reference, no updatedAt churn
  })

  it("normalization only affects the targeted agent", () => {
    const base = [createAgent("A"), createAgent("B")]
    // renameAgent stores raw (untrimmed) names for both.
    const withSpaces = renameAgent(
      renameAgent(base, base[0].id, "  A  "),
      base[1].id,
      "  B  ",
    )
    const normalized = normalizeAgentName(withSpaces, base[0].id)
    expect(normalized[0].name).toBe("A")
    expect(normalized[1].name).toBe("  B  ") // untouched
  })

  it("updates description and config immutably", () => {
    const agents = [createAgent("A")]
    const withDesc = updateAgentDescription(agents, agents[0].id, "desc")
    expect(withDesc[0].description).toBe("desc")
    const config = { ...defaultAgentConfig(), promptTemplate: "Hi {{name}}" }
    const withConfig = updateAgentConfig(withDesc, agents[0].id, config)
    expect(withConfig[0].config.promptTemplate).toBe("Hi {{name}}")
    expect(agents[0].config.promptTemplate).toBe("")
  })

  it("duplicates with a new id, copied config, and (copy) suffix", () => {
    const original = createAgent("Sales")
    const configured = updateAgentConfig([original], original.id, {
      promptTemplate: "Hello {{name}}",
      promptVariables: [{ id: "v1", name: "name", value: "Vivek" }],
      voice: "verse",
      turnDetection: { threshold: 0.4, prefix_padding_ms: 150, silence_duration_ms: 900 },
    })
    const duplicated = duplicateAgent(configured, original.id)

    expect(duplicated).toHaveLength(2)
    const copy = duplicated[1]
    expect(copy.id).not.toBe(original.id)
    expect(copy.name).toBe("Sales (copy)")
    expect(copy.config.promptTemplate).toBe("Hello {{name}}")
    expect(copy.config.voice).toBe("verse")
    // Deep copy: editing the copy's variables must not affect the source.
    copy.config.promptVariables[0].value = "changed"
    expect(configured[0].config.promptVariables[0].value).toBe("Vivek")
  })

  it("duplicate is a no-op for an unknown id", () => {
    const agents = [createAgent("A")]
    expect(duplicateAgent(agents, "missing")).toEqual(agents)
  })
})

describe("deletion and selection", () => {
  it("deleting the last agent recreates a Default agent", () => {
    const agents = [createAgent("Only")]
    const afterDelete = deleteAgent(agents, agents[0].id)
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].name).toBe("Default")
    expect(afterDelete[0].id).not.toBe(agents[0].id)
  })

  it("deleting a non-selected agent keeps the rest", () => {
    const a = createAgent("A")
    const b = createAgent("B")
    const afterDelete = deleteAgent([a, b], a.id)
    expect(afterDelete.map((x) => x.id)).toEqual([b.id])
  })

  it("resolveSelectedAgentId keeps a valid selection, else falls back", () => {
    const a = createAgent("A")
    const b = createAgent("B")
    expect(resolveSelectedAgentId([a, b], b.id)).toBe(b.id)
    expect(resolveSelectedAgentId([a, b], "missing")).toBe(a.id)
    expect(resolveSelectedAgentId([], "missing")).toBe("")
  })

  it("ensureAgents creates a Default only when empty", () => {
    expect(ensureAgents([])).toHaveLength(1)
    expect(ensureAgents([])[0].name).toBe("Default")
    const existing = [createAgent("A")]
    expect(ensureAgents(existing)).toBe(existing)
  })
})

describe("persistence round-trip", () => {
  it("saves and loads agents", () => {
    const agents = addAgent([createAgent("A")], createAgent("B"))
    saveAgents(agents)
    const loaded = loadAgents()
    expect(loaded.map((a) => a.name)).toEqual(["A", "B"])
  })

  it("persists and reads the selected agent id", () => {
    saveSelectedAgentId("agent-123")
    expect(loadSelectedAgentId()).toBe("agent-123")
  })

  it("returns an empty list when storage is empty", () => {
    expect(loadAgents()).toEqual([])
  })
})

describe("defensive parsing / migration", () => {
  it("returns [] for non-array or malformed JSON", () => {
    localStorage.setItem(AGENTS_STORAGE_KEY, "{not json")
    expect(loadAgents()).toEqual([])
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify({ not: "array" }))
    expect(loadAgents()).toEqual([])
  })

  it("repairs missing/invalid fields instead of crashing", () => {
    const parsed = parseAgent({ name: "Partial" }) as Agent
    expect(parsed.name).toBe("Partial")
    expect(parsed.id).toBeTruthy()
    expect(parsed.description).toBe("")
    expect(parsed.config).toEqual(defaultAgentConfig())
    expect(parsed.schemaVersion).toBeTypeOf("number")
  })

  it("drops non-object entries but keeps valid ones", () => {
    localStorage.setItem(
      AGENTS_STORAGE_KEY,
      JSON.stringify([null, 42, "x", { name: "Keep" }]),
    )
    const loaded = loadAgents()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].name).toBe("Keep")
  })

  it("filters invalid prompt variables and clamps out-of-range VAD", () => {
    const parsed = parseAgent({
      name: "A",
      config: {
        promptTemplate: "x",
        promptVariables: [
          { id: "v1", name: "ok", value: "1" },
          { id: "v2", name: 5, value: "bad-name-type" },
          "nope",
        ],
        voice: "verse",
        turnDetection: {
          threshold: 9,
          prefix_padding_ms: -100,
          silence_duration_ms: 99999,
        },
      },
    }) as Agent
    expect(parsed.config.promptVariables).toEqual([
      { id: "v1", name: "ok", value: "1" },
    ])
    expect(parsed.config.turnDetection).toEqual({
      threshold: 1,
      prefix_padding_ms: 0,
      silence_duration_ms: 5000,
    })
  })

  it("coerces a non-string voice to null", () => {
    const parsed = parseAgent({ name: "A", config: { voice: 123 } }) as Agent
    expect(parsed.config.voice).toBeNull()
  })

  it("regenerates duplicate ids on load", () => {
    const shared = createAgent("A")
    const clash = { ...createAgent("B"), id: shared.id }
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify([shared, clash]))
    const loaded = loadAgents()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].id).not.toBe(loaded[1].id)
  })
})

describe("getAgentById", () => {
  it("finds an agent or returns undefined", () => {
    const a = createAgent("A")
    expect(getAgentById([a], a.id)).toBe(a)
    expect(getAgentById([a], "missing")).toBeUndefined()
  })
})
