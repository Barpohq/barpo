// Validating config values and filling them in with defaults.
//
// CORE RULE: validation NEVER throws and never stops the config from being
// read. A bad field falls back to its default value, and the reason goes
// into the list of warnings.
//
// Why? The config is a file edited by hand. Letting one bad field make the
// whole platform fail to start is a bad trade — especially later, when the
// config is written through the web UI and a half-written file must not
// take the server down.
//
// For security-relevant fields it is the other way round: a suspicious
// value is RESET to the default; there is no "do the best we can" here.

import { FIELDS, type Config, type FieldSpec, type PartialConfig } from './schema.ts'

/** A problem hit while reading the config — it does not stop the work */
export interface ConfigWarning {
  /** Which field (dotted path); for a general problem, the file path */
  path: string
  reason: string
}

export interface ValidationResult {
  config: Config
  warnings: ConfigWarning[]
}

// ---------------------------------------------------------------------------
// Working with dotted paths
// ---------------------------------------------------------------------------

/** Reads the value at `agent.compaction.enabled` */
export function readByPath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Writes a value at `agent.compaction.enabled`, creating intermediate objects */
export function writeByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!
    const next = current[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts.at(-1)!] = value
}

// ---------------------------------------------------------------------------
// Validating a single field
// ---------------------------------------------------------------------------

/**
 * Validates a field value.
 *
 * Returns: the accepted value + (if it was replaced) the reason.
 * A reason present means the value fell back to the default.
 */
export function validateField(
  spec: FieldSpec,
  raw: unknown,
): { value: unknown; reason?: string } {
  // A field that was not specified — default value, and that is not an error
  if (raw === undefined) return { value: defaultCopy(spec) }

  if (raw === null) {
    if (spec.nullable) return { value: null }
    return { value: defaultCopy(spec), reason: 'null is not allowed' }
  }

  switch (spec.kind) {
    case 'boolean':
      if (typeof raw !== 'boolean') {
        return { value: spec.default, reason: `expected a boolean, got ${typeName(raw)}` }
      }
      return { value: raw }

    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { value: spec.default, reason: `expected a number, got ${typeName(raw)}` }
      }
      // A value outside the range is CLAMPED, not reset to the default:
      // the user's intent is clear ("I wanted it bigger"), we simply bring
      // it back into the allowed range.
      const min = spec.range?.min
      const max = spec.range?.max
      if (min !== undefined && raw < min) {
        return { value: min, reason: `${raw} is too small, raised to ${min}` }
      }
      if (max !== undefined && raw > max) {
        return { value: max, reason: `${raw} is too large, lowered to ${max}` }
      }
      return { value: raw }
    }

    case 'text':
      if (typeof raw !== 'string') {
        return { value: spec.default, reason: `expected a string, got ${typeName(raw)}` }
      }
      return { value: raw }

    case 'select': {
      if (typeof raw !== 'string') {
        return { value: spec.default, reason: `expected a string, got ${typeName(raw)}` }
      }
      const options = spec.options ?? []
      if (!options.includes(raw)) {
        return {
          value: spec.default,
          reason: `"${raw}" is not allowed, options: ${options.join(', ')}`,
        }
      }
      return { value: raw }
    }

    case 'stringList': {
      if (!Array.isArray(raw)) {
        // A COPY is returned: the default array in `FIELDS` is a shared
        // object. Handing it out directly would mean a caller doing `push`
        // corrupts the default value itself — a hard-to-find bug that leaks
        // into every later session.
        return { value: [...(spec.default as string[])], reason: `expected a list, got ${typeName(raw)}` }
      }
      // Bad elements inside the list are dropped, not the whole list — the
      // part the user got right is kept
      const cleaned = raw.filter((e): e is string => typeof e === 'string')
      if (cleaned.length !== raw.length) {
        return {
          value: cleaned,
          reason: `${raw.length - cleaned.length} non-string item(s) were dropped`,
        }
      }
      return { value: cleaned }
    }
  }
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'list'
  if (value === null) return 'null'
  return typeof value
}

/**
 * A safe copy of a default value.
 *
 * `FIELDS` is a module-level constant object. Returning an array from it
 * directly means that when the caller mutates it (`push`) the default value
 * ITSELF is corrupted, and every later session gets the corrupted value.
 * Primitives need no copy, but solving it in one place is safer — a newly
 * added array field cannot be forgotten.
 */
function defaultCopy(spec: FieldSpec): unknown {
  return Array.isArray(spec.default) ? [...spec.default] : spec.default
}

// ---------------------------------------------------------------------------
// Validating the whole config
// ---------------------------------------------------------------------------

/**
 * Builds a complete, validated config from a raw object.
 *
 * The incoming object may have any shape (JSON that came from a file) —
 * only the paths declared in `FIELDS` are read, the rest is ignored (though
 * an unknown field produces a warning, since it is usually a typo).
 */
export function validateConfig(raw: unknown): ValidationResult {
  const warnings: ConfigWarning[] = []
  const result: Record<string, unknown> = {}

  for (const spec of FIELDS) {
    const { value, reason } = validateField(spec, readByPath(raw, spec.path))
    writeByPath(result, spec.path, value)
    if (reason) warnings.push({ path: spec.path, reason })
  }

  for (const unknownPath of unknownPaths(raw)) {
    warnings.push({ path: unknownPath, reason: 'unknown setting — ignored' })
  }

  return { config: result as unknown as Config, warnings }
}

/**
 * Finds paths that are not declared in the config.
 *
 * A typo must not disappear silently: a user who wrote
 * `agent.compaction.enabeld` needs to know the setting is not taking effect.
 */
function unknownPaths(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []

  const known = new Set<string>(FIELDS.map((f) => f.path))
  // Intermediate paths are legitimate too: `agent`, `agent.compaction`
  for (const f of FIELDS) {
    const parts = f.path.split('.')
    for (let i = 1; i < parts.length; i += 1) known.add(parts.slice(0, i).join('.'))
  }

  const found: string[] = []
  const walk = (object: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key
      // `$schema` is for editors, not a setting
      if (path === '$schema') continue
      if (!known.has(path)) {
        found.push(path)
        continue // do not descend — the whole branch is unknown
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path)
      }
    }
  }
  walk(raw as Record<string, unknown>, '')
  return found
}

/** The default config — used when there is no file at all */
export function defaultConfig(): Config {
  return validateConfig({}).config
}

/**
 * Merges two configs: `upper` overrides `lower`.
 *
 * Only fields that are PRESENT override — an `undefined` value does not
 * erase the lower layer. That matters for the global and project configs:
 * if the project file changes one setting, the rest stay as the global ones.
 *
 * Arrays are replaced WHOLESALE, not concatenated — for `tools.enabled`
 * that is the only correct semantics (if the project says "read and grep
 * only", the global `bash` must not sneak back in).
 */
export function mergeConfigs(lower: PartialConfig, upper: PartialConfig): PartialConfig {
  const result: Record<string, unknown> = {}
  for (const source of [lower, upper]) {
    for (const [section, values] of Object.entries(source)) {
      if (typeof values !== 'object' || values === null) continue
      const existing = (result[section] as Record<string, unknown> | undefined) ?? {}
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue
        existing[key] = value
      }
      result[section] = existing
    }
  }
  return result as PartialConfig
}
