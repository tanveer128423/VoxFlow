// Pure, dependency-free prompt templating for VoxFlow.
//
// Templates use `{{variable_name}}` placeholders. Rendering only performs plain
// text substitution of known variables; it never evaluates code or expressions.

export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// Matches a `{{ ... }}` placeholder and captures the trimmed inner token.
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g

export type PromptVariable = {
  id: string
  name: string
  value: string
}

export type RenderedPrompt = {
  text: string
  // Placeholders whose name is valid but has no defined, non-empty value.
  missing: string[]
  // Placeholder names that are not valid identifiers.
  invalid: string[]
}

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME_PATTERN.test(name)
}

export function createVariableId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

// Unique placeholder names referenced by the template, in first-seen order.
export function extractPlaceholders(template: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

// Variables with valid, unique, non-empty names mapped to their value.
// Later duplicates overwrite earlier ones.
function toValueMap(variables: PromptVariable[]): Map<string, string> {
  const values = new Map<string, string>()
  for (const variable of variables) {
    if (isValidVariableName(variable.name)) {
      values.set(variable.name, variable.value)
    }
  }
  return values
}

export function renderPrompt(
  template: string,
  variables: PromptVariable[],
): RenderedPrompt {
  const values = toValueMap(variables)
  const missing: string[] = []
  const invalid: string[] = []

  const text = template.replace(PLACEHOLDER_PATTERN, (whole, rawName: string) => {
    const name = rawName.trim()
    if (!isValidVariableName(name)) {
      if (!invalid.includes(name)) invalid.push(name)
      return whole
    }
    const value = values.get(name)
    if (value === undefined || value === "") {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return value
  })

  return { text, missing, invalid }
}

export type PromptValidation = {
  // Whether a voice session may be started with this configuration.
  canStart: boolean
  // Actionable messages describing exactly what must be fixed.
  errors: string[]
}

// Decide whether the prompt configuration is safe to start a session with.
// An untouched/default prompt (no placeholders, no variables) is always valid.
export function validatePromptConfig(
  template: string,
  variables: PromptVariable[],
): PromptValidation {
  const rendered = renderPrompt(template, variables)
  const { invalidNames, duplicateNames } = findVariableNameIssues(variables)
  const errors: string[] = []

  if (invalidNames.length > 0) {
    errors.push(`Fix invalid variable name(s): ${invalidNames.join(", ")}`)
  }
  if (duplicateNames.length > 0) {
    errors.push(`Remove duplicate variable name(s): ${duplicateNames.join(", ")}`)
  }
  if (rendered.invalid.length > 0) {
    errors.push(
      `Fix invalid placeholder(s) in the prompt: ${rendered.invalid
        .map((name) => `{{${name}}}`)
        .join(", ")}`,
    )
  }
  if (rendered.missing.length > 0) {
    errors.push(`Provide a value for: ${rendered.missing.join(", ")}`)
  }

  return { canStart: errors.length === 0, errors }
}

// Variable rows whose names are invalid or duplicated, for UI feedback.
export function findVariableNameIssues(variables: PromptVariable[]): {
  invalidNames: string[]
  duplicateNames: string[]
} {
  const invalidNames: string[] = []
  const seen = new Set<string>()
  const duplicateNames = new Set<string>()
  for (const variable of variables) {
    const name = variable.name.trim()
    if (name === "") continue
    if (!isValidVariableName(name)) {
      if (!invalidNames.includes(name)) invalidNames.push(name)
      continue
    }
    if (seen.has(name)) {
      duplicateNames.add(name)
    } else {
      seen.add(name)
    }
  }
  return { invalidNames, duplicateNames: [...duplicateNames] }
}
