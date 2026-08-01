// Finding, reading and merging the config files.
//
// Two layers, bottom to top (the upper one overrides):
//   1) global  — ~/.barpo/config.json
//   2) project — <work dir>/.barpo/config.json
//
// Why two? Global is the user's usual settings (which model, which mode).
// Project is a restriction for this particular job ("read-only tools in
// this directory"). It is natural for the project file to lower a global
// setting, but not to raise it — the project file ships with the repo and
// is therefore less trusted (the same reasoning as pi's "project trust"
// problem).
//
// THEREFORE: `extraDenyList` is merged, while for other fields the project
// file can only RESTRICT — that is what `applyProjectRestriction` does.
//
// Reading a file NEVER throws: a missing file, malformed JSON or a
// permission error produces a warning and the defaults are used.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mergeConfigs, validateConfig, type ConfigWarning, type ValidationResult } from './validate.ts'
import type { Config, PartialConfig } from './schema.ts'

/** Config file name — the same for global and project */
export const CONFIG_FILE = 'config.json'

/** The config directory inside a project */
export const PROJECT_DIR = '.barpo'

export interface ReadOptions {
  /** Directory the project config is looked for in. If omitted, only the global one is read. */
  workDir?: string
  /** Global config directory (swapped out in tests) */
  globalDir?: string
}

export interface ConfigResult extends ValidationResult {
  /** Files that were actually read — for diagnostics and the UI */
  readFiles: string[]
}

/** The global config directory: `~/.barpo/` */
export function globalConfigDir(): string {
  const env = process.env.PLATFORM_CONFIG_DIR?.trim()
  if (env) return env
  return join(homedir(), '.barpo')
}

/**
 * Reads a single JSON file.
 *
 * Three cases are distinguished:
 *   - no file        → `undefined`, no warning (this is the normal case)
 *   - malformed JSON → `undefined` + a warning
 *   - read fine      → the object
 */
export function readConfigFile(
  path: string,
  warnings: ConfigWarning[],
): PartialConfig | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // ENOENT — no file, which is expected and needs no warning.
    // Other errors (no permission, a directory where a file was expected)
    // do need to be reported.
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      warnings.push({ path, reason: `could not be read: ${errorText(error)}` })
    }
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push({ path, reason: 'a JSON object was expected in the file' })
      return undefined
    }
    return parsed as PartialConfig
  } catch (error) {
    warnings.push({ path, reason: `malformed JSON: ${errorText(error)}` })
    return undefined
  }
}

/**
 * Restricts what the project config can do.
 *
 * The project file ships with the repo — meaning it may have been written
 * by someone outside the platform. So it cannot LOWER the security
 * boundary:
 *   - it cannot raise `permission.mode` to `auto` (only lower it to `confirm`)
 *   - it cannot remove entries from `extraDenyList` — only add
 *   - it cannot widen `tools.enabled` — only narrow it
 *
 * The remaining fields (context size, timeouts) are not security-relevant,
 * so they override freely.
 */
export function applyProjectRestriction(global: Config, project: PartialConfig): PartialConfig {
  const result: PartialConfig = JSON.parse(JSON.stringify(project)) as PartialConfig

  // The mode cannot be raised
  if (result.permission?.mode === 'auto' && global.permission.mode !== 'auto') {
    delete result.permission.mode
  }

  // Deny entries are added, not replaced
  if (result.permission?.extraDenyList) {
    result.permission.extraDenyList = [
      ...new Set([...global.permission.extraDenyList, ...result.permission.extraDenyList]),
    ]
  }

  // The tool list can only narrow
  if (result.agent?.tools?.enabled) {
    const allowed = new Set(global.agent.tools.enabled)
    result.agent.tools.enabled = result.agent.tools.enabled.filter((t) => allowed.has(t))
  }

  return result
}

/**
 * Reads the full config: global + project, validated and filled in.
 *
 * Never throws — any problem lands in `warnings` and the defaults carry on.
 */
export function readConfig(options?: ReadOptions): ConfigResult {
  const warnings: ConfigWarning[] = []
  const readFiles: string[] = []

  const globalPath = join(options?.globalDir ?? globalConfigDir(), CONFIG_FILE)
  const globalRaw = readConfigFile(globalPath, warnings)
  if (globalRaw) readFiles.push(globalPath)

  // The global part is fully validated first — the project restriction has
  // to be computed against validated values (for example `tools.enabled`
  // should narrow relative to the default list, not to an empty list)
  const globalResult = validateConfig(globalRaw ?? {})
  warnings.push(...globalResult.warnings.map((w) => tagPath(w, globalPath)))

  if (!options?.workDir) {
    return { config: globalResult.config, warnings, readFiles }
  }

  const projectPath = join(options.workDir, PROJECT_DIR, CONFIG_FILE)
  const projectRaw = readConfigFile(projectPath, warnings)
  if (!projectRaw) {
    return { config: globalResult.config, warnings, readFiles }
  }
  readFiles.push(projectPath)

  const restricted = applyProjectRestriction(globalResult.config, projectRaw)
  const merged = mergeConfigs(globalRaw ?? {}, restricted)
  const final = validateConfig(merged)

  // Warnings already reported at the global stage must not be repeated
  const seen = new Set(globalResult.warnings.map((w) => `${w.path}|${w.reason}`))
  warnings.push(
    ...final.warnings
      .filter((w) => !seen.has(`${w.path}|${w.reason}`))
      .map((w) => tagPath(w, projectPath)),
  )

  return { config: final.config, warnings, readFiles }
}

/** Adds to a warning which file it came from */
function tagPath(w: ConfigWarning, file: string): ConfigWarning {
  return { path: w.path, reason: `${w.reason} (${file})` }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
//
// The config must not be read on every chat request — the file rarely
// changes. When it is written through the web UI, `refreshConfig()` is called.

let _cache: ConfigResult | null = null
let _cacheKey = ''

/**
 * The cached config. The first call reads from the file.
 * If the work directory changes it is re-read (every project has its own config).
 */
export function config(options?: ReadOptions): ConfigResult {
  const key = `${options?.globalDir ?? ''}|${options?.workDir ?? ''}`
  if (_cache && _cacheKey === key) return _cache
  _cache = readConfig(options)
  _cacheKey = key
  return _cache
}

/** Clears the cache — after the file changes, or in tests */
export function refreshConfig(): void {
  _cache = null
  _cacheKey = ''
}
