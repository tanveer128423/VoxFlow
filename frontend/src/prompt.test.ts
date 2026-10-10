import { describe, expect, it } from "vitest"

import {
  extractPlaceholders,
  findVariableNameIssues,
  isValidVariableName,
  renderPrompt,
  validatePromptConfig,
  type PromptVariable,
} from "./prompt"

function variable(name: string, value: string): PromptVariable {
  return { id: `${name}-${value}`, name, value }
}

describe("isValidVariableName", () => {
  it("accepts identifier-style names", () => {
    expect(isValidVariableName("name")).toBe(true)
    expect(isValidVariableName("_private")).toBe(true)
    expect(isValidVariableName("user_name2")).toBe(true)
  })

  it("rejects invalid names", () => {
    expect(isValidVariableName("2name")).toBe(false)
    expect(isValidVariableName("user name")).toBe(false)
    expect(isValidVariableName("user-name")).toBe(false)
    expect(isValidVariableName("")).toBe(false)
  })
})

describe("extractPlaceholders", () => {
  it("returns unique names in first-seen order, trimming whitespace", () => {
    const template = "Hi {{ name }}, you are {{role}}. Bye {{name}}."
    expect(extractPlaceholders(template)).toEqual(["name", "role"])
  })
})

describe("renderPrompt", () => {
  it("renders the default (no placeholders) template unchanged", () => {
    const result = renderPrompt("You are a helpful assistant.", [])
    expect(result.text).toBe("You are a helpful assistant.")
    expect(result.missing).toEqual([])
    expect(result.invalid).toEqual([])
  })

  it("substitutes defined variables as plain text", () => {
    const result = renderPrompt("Hello {{name}} from {{city}}.", [
      variable("name", "Vivek"),
      variable("city", "Pune"),
    ])
    expect(result.text).toBe("Hello Vivek from Pune.")
    expect(result.missing).toEqual([])
  })

  it("reports missing variables and leaves the placeholder intact", () => {
    const result = renderPrompt("Hello {{name}} from {{city}}.", [
      variable("name", "Vivek"),
    ])
    expect(result.text).toBe("Hello Vivek from {{city}}.")
    expect(result.missing).toEqual(["city"])
  })

  it("treats an empty value as missing", () => {
    const result = renderPrompt("Hello {{name}}.", [variable("name", "")])
    expect(result.missing).toEqual(["name"])
    expect(result.text).toBe("Hello {{name}}.")
  })

  it("reports invalid placeholder names without substituting", () => {
    const result = renderPrompt("Hello {{bad name}}.", [])
    expect(result.invalid).toEqual(["bad name"])
    expect(result.text).toBe("Hello {{bad name}}.")
  })

  it("does not evaluate code; substitution is literal text only", () => {
    const result = renderPrompt("Value: {{v}}", [
      variable("v", "{{name}} ${1+1} <script>"),
    ])
    // The injected value is inserted verbatim and not re-processed.
    expect(result.text).toBe("Value: {{name}} ${1+1} <script>")
    expect(result.missing).toEqual([])
  })
})

describe("validatePromptConfig", () => {
  it("allows an untouched/default prompt with no variables", () => {
    expect(validatePromptConfig("", []).canStart).toBe(true)
    expect(
      validatePromptConfig("You are a helpful assistant.", []).canStart,
    ).toBe(true)
  })

  it("allows a fully-resolved custom prompt", () => {
    const result = validatePromptConfig("Hello {{name}}.", [
      variable("name", "Vivek"),
    ])
    expect(result.canStart).toBe(true)
    expect(result.errors).toEqual([])
  })

  it("blocks when a required variable has no definition", () => {
    const result = validatePromptConfig("Hello {{name}} from {{city}}.", [
      variable("name", "Vivek"),
    ])
    expect(result.canStart).toBe(false)
    expect(result.errors.join(" ")).toContain("city")
  })

  it("blocks when a required variable value is empty", () => {
    const result = validatePromptConfig("Hello {{name}}.", [
      variable("name", ""),
    ])
    expect(result.canStart).toBe(false)
    expect(result.errors.join(" ")).toContain("name")
  })

  it("blocks when a variable definition has an invalid name", () => {
    const result = validatePromptConfig("Hello.", [variable("2bad", "x")])
    expect(result.canStart).toBe(false)
    expect(result.errors.join(" ")).toContain("2bad")
  })

  it("blocks when variable definitions are duplicated", () => {
    const result = validatePromptConfig("Hello {{name}}.", [
      variable("name", "a"),
      variable("name", "b"),
    ])
    expect(result.canStart).toBe(false)
    expect(result.errors.join(" ")).toContain("name")
  })

  it("blocks when the template has an invalid placeholder", () => {
    const result = validatePromptConfig("Hello {{bad name}}.", [])
    expect(result.canStart).toBe(false)
    expect(result.errors.join(" ")).toContain("bad name")
  })
})

describe("findVariableNameIssues", () => {
  it("flags invalid and duplicate names and ignores blank rows", () => {
    const issues = findVariableNameIssues([
      variable("name", "a"),
      variable("name", "b"),
      variable("2bad", "c"),
      variable("", "ignored"),
    ])
    expect(issues.duplicateNames).toEqual(["name"])
    expect(issues.invalidNames).toEqual(["2bad"])
  })
})
