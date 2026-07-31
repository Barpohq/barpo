// Builtin skills — the ones that ship with the platform.
//
// They behave LIKE ORDINARY SKILLS: they pass through the catalog, appear in
// the "Skill store" and the user installs them. The only difference is the
// source — not GitHub, but the `skills/` directory inside the repo.
//
// These tests pin that down: when the repo moves to GitHub the catalog, the
// install flow and the UI flows must not change.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { createSkillSource, readSkills, readSkillSources, syncSkills } from '../src/repo.ts'
import {
  BUILTIN_SOURCE_URL,
  builtinToStore,
  ensureBuiltinSource,
  scanBuiltins,
} from '../src/builtin-skills.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  db.close()
})

/** Calls `ensureBuiltinSource` against the test database */
function ensure() {
  return ensureBuiltinSource(
    (s) => createSkillSource(s, db),
    (sourceId, found, sha) => syncSkills(sourceId, found, sha, db),
  )
}

describe('scanBuiltins', () => {
  test('finds the skills that live inside the repo', () => {
    const scan = scanBuiltins()
    const names = scan.skills.map((s) => s.name)
    expect(names).toContain('dashboard-create')
    expect(names).toContain('dashboard-jsx')
  })

  test('every description is present and substantial — it is what goes into the prompt', () => {
    for (const s of scanBuiltins().skills) {
      expect(s.description.length).toBeGreaterThan(20)
    }
  })

  test('paths have the same shape as in the GitHub variant', () => {
    // When the repo moves to GitHub the paths have to line up, otherwise the
    // catalog entries — and with them the installs — would be lost.
    for (const s of scanBuiltins().skills) {
      expect(s.path).toMatch(/^[a-z0-9-]+\/SKILL\.md$/)
    }
  })
})

describe('ensureBuiltinSource — writing to the catalog', () => {
  test('the source and its skills land in the catalog', () => {
    const result = ensure()
    expect(result).not.toBeNull()
    expect(result!.count).toBeGreaterThan(0)

    const sources = readSkillSources(db)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.kind).toBe('builtin')
    expect(sources[0]!.url).toBe(BUILTIN_SOURCE_URL)

    const names = readSkills(db).map((s) => s.name)
    expect(names).toContain('dashboard-create')
    expect(names).toContain('dashboard-jsx')
  })

  test('a repeat call creates NO DUPLICATES', () => {
    // It runs on every start-up, so it has to be idempotent
    ensure()
    const firstCount = readSkills(db).length
    ensure()
    ensure()

    expect(readSkillSources(db)).toHaveLength(1)
    expect(readSkills(db)).toHaveLength(firstCount)
  })

  test('the skills arrive uninstalled', () => {
    // The user installs them THEMSELVES — nothing is force-enabled
    ensure()
    for (const s of readSkills(db)) {
      expect(s.installs).toEqual([])
    }
  })
})

describe('builtinToStore — installing', () => {
  test('copies the skill directory into the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    try {
      const target = join(dir, 'skill')
      expect(builtinToStore('dashboard-jsx/SKILL.md', target)).toBe(true)
      expect(existsSync(join(target, 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns false for an unknown skill and DOES NOT THROW', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    try {
      expect(builtinToStore('no-such-skill/SKILL.md', join(dir, 'x'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
