// Tests for reading the config files.
//
// The most important part: the PROJECT RESTRICTION. The project config
// ships with the repo, meaning someone else may have written it. That it
// cannot lower the security boundary is enforced at the code level — these
// tests are what check it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_FILE,
  PROJECT_DIR,
  config,
  readConfig,
  refreshConfig,
  applyProjectRestriction,
} from '../src/read.ts'
import { defaultConfig } from '../src/validate.ts'

let root: string
let globalDir: string
let workDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'barpo-config-'))
  globalDir = join(root, 'global')
  workDir = join(root, 'project')
  mkdirSync(globalDir, { recursive: true })
  mkdirSync(join(workDir, PROJECT_DIR), { recursive: true })
  refreshConfig()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  refreshConfig()
})

function writeGlobal(content: unknown): void {
  writeFileSync(join(globalDir, CONFIG_FILE), JSON.stringify(content))
}

function writeProject(content: unknown): void {
  writeFileSync(join(workDir, PROJECT_DIR, CONFIG_FILE), JSON.stringify(content))
}

describe('reading files', () => {
  test('no file at all gives the default config, with no warnings', () => {
    const r = readConfig({ globalDir })
    expect(r.config).toEqual(defaultConfig())
    expect(r.warnings).toEqual([])
    expect(r.readFiles).toEqual([])
  })

  test('malformed JSON does not stop the platform', () => {
    writeFileSync(join(globalDir, CONFIG_FILE), '{ broken json,,, ')
    const r = readConfig({ globalDir })
    expect(r.config).toEqual(defaultConfig())
    expect(r.warnings.some((w) => w.reason.includes('malformed JSON'))).toBe(true)
  })

  test('JSON that is not an object (an array) warns', () => {
    writeFileSync(join(globalDir, CONFIG_FILE), '[1, 2, 3]')
    const r = readConfig({ globalDir })
    expect(r.warnings.some((w) => w.reason.includes('a JSON object'))).toBe(true)
  })

  test('global config values are applied', () => {
    writeGlobal({ permission: { mode: 'auto' }, agent: { compaction: { reserveTokens: 8000 } } })
    const r = readConfig({ globalDir })
    expect(r.config.permission.mode).toBe('auto')
    expect(r.config.agent.compaction.reserveTokens).toBe(8000)
    // Unspecified fields take their default
    expect(r.config.agent.compaction.enabled).toBe(true)
    expect(r.readFiles).toHaveLength(1)
  })

  test('the project config overrides the global one', () => {
    writeGlobal({ agent: { compaction: { reserveTokens: 8000 } } })
    writeProject({ agent: { compaction: { reserveTokens: 4000 } } })
    const r = readConfig({ globalDir, workDir })
    expect(r.config.agent.compaction.reserveTokens).toBe(4000)
    expect(r.readFiles).toHaveLength(2)
  })
})

describe('project restriction — the security boundary does not drop', () => {
  test('the project cannot RAISE the mode to auto', () => {
    // Global is confirm, the project asks for auto — it is refused
    writeGlobal({ permission: { mode: 'confirm' } })
    writeProject({ permission: { mode: 'auto' } })
    const r = readConfig({ globalDir, workDir })
    expect(r.config.permission.mode).toBe('confirm')
  })

  test('the project CAN lower the mode to confirm', () => {
    writeGlobal({ permission: { mode: 'auto' } })
    writeProject({ permission: { mode: 'confirm' } })
    const r = readConfig({ globalDir, workDir })
    expect(r.config.permission.mode).toBe('confirm')
  })

  test('the project cannot remove deny entries, only add them', () => {
    writeGlobal({ permission: { extraDenyList: ['deploy'] } })
    writeProject({ permission: { extraDenyList: ['terraform'] } })
    const r = readConfig({ globalDir, workDir })
    expect(r.config.permission.extraDenyList).toContain('deploy')
    expect(r.config.permission.extraDenyList).toContain('terraform')
  })

  test('the project cannot WIDEN the tool list', () => {
    writeGlobal({ agent: { tools: { enabled: ['read', 'grep'] } } })
    writeProject({ agent: { tools: { enabled: ['read', 'grep', 'bash', 'write'] } } })
    const r = readConfig({ globalDir, workDir })
    expect(r.config.agent.tools.enabled).toEqual(['read', 'grep'])
  })

  test('the project CAN narrow the tool list', () => {
    writeGlobal({ agent: { tools: { enabled: ['read', 'grep', 'bash'] } } })
    writeProject({ agent: { tools: { enabled: ['read'] } } })
    const r = readConfig({ globalDir, workDir })
    expect(r.config.agent.tools.enabled).toEqual(['read'])
  })

  test('fields that are not security-relevant override freely', () => {
    writeGlobal({ agent: { tools: { bashTimeoutSeconds: 60 } } })
    writeProject({ agent: { tools: { bashTimeoutSeconds: 300 } } })
    const r = readConfig({ globalDir, workDir })
    expect(r.config.agent.tools.bashTimeoutSeconds).toBe(300)
  })

  test('applyProjectRestriction does not mutate the global object', () => {
    const global = defaultConfig()
    const copy = JSON.parse(JSON.stringify(global)) as typeof global
    applyProjectRestriction(global, { permission: { extraDenyList: ['x'] } })
    expect(global).toEqual(copy)
  })
})

describe('cache', () => {
  test('the second call comes from the cache', () => {
    writeGlobal({ permission: { mode: 'auto' } })
    const first = config({ globalDir })
    // Change the file, but do not clear the cache
    writeGlobal({ permission: { mode: 'confirm' } })
    const second = config({ globalDir })
    expect(second).toBe(first)
    expect(second.config.permission.mode).toBe('auto')
  })

  test('refreshConfig clears the cache', () => {
    writeGlobal({ permission: { mode: 'auto' } })
    config({ globalDir })
    writeGlobal({ permission: { mode: 'confirm' } })
    refreshConfig()
    expect(config({ globalDir }).config.permission.mode).toBe('confirm')
  })

  test('a changed work directory triggers a re-read', () => {
    // Every project has its own config — the cache must not mix them up
    writeGlobal({ agent: { tools: { bashTimeoutSeconds: 60 } } })
    const first = config({ globalDir })
    writeProject({ agent: { tools: { bashTimeoutSeconds: 90 } } })
    const second = config({ globalDir, workDir })
    expect(second).not.toBe(first)
    expect(second.config.agent.tools.bashTimeoutSeconds).toBe(90)
  })
})
