// Skills: the database layer + syncing into a project.
//
// Network requests (GitHub) are NOT EXERCISED — they depend on an external
// service. What is checked here is the logic that runs AFTER they return: the
// catalog UPSERT, the scope, and how `.platforma/skills/` on disk is brought
// into line with the database.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, setDb } from '../src/db.ts'
import { parseGithubRef } from '../src/github.ts'
import {
  activeSkills,
  createProject,
  deleteSkillSource,
  readSkillSources,
  createSkillSource,
  readSkill,
  installSkill,
  uninstallSkill,
  syncSkills,
  readSkills,
} from '../src/repo.ts'
import { WORK_SKILL_DIR, syncToProject, skillStorePath } from '../src/skill-store.ts'

let db: Database
let store: string

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
  store = mkdtempSync(join(tmpdir(), 'store-'))
  process.env.PLATFORM_SKILLS = store
})

afterEach(() => {
  setDb(null)
  db.close()
  rmSync(store, { recursive: true, force: true })
  delete process.env.PLATFORM_SKILLS
})

/** A source plus one skill, for the tests */
function sourceAndSkill(name = 'pdf-fill', path = `${name}/SKILL.md`) {
  const source = createSkillSource(
    { kind: 'github', url: `https://github.com/test/${name}`, owner: 'test', repo: name, ref: 'main' },
    db,
  )
  syncSkills(
    source.id,
    [{ path, name, description: `${name} description`, warnings: [] }],
    'sha1',
    db,
  )
  const skill = readSkills(db).find((s) => s.path === path)!
  return { source, skill }
}

// ---------------------------------------------------------------------------

describe('parseGithubRef', () => {
  test('a full URL', () => {
    expect(parseGithubRef('https://github.com/anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: '',
    })
  })

  test('the short form', () => {
    expect(parseGithubRef('anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: '',
    })
  })

  test('the .git suffix is stripped', () => {
    expect(parseGithubRef('github.com/a/b.git')?.repo).toBe('b')
  })

  test('the ref is taken from /tree/<branch>', () => {
    expect(parseGithubRef('https://github.com/a/b/tree/dev')?.ref).toBe('dev')
  })

  test('the SSH form', () => {
    expect(parseGithubRef('git@github.com:a/b.git')).toEqual({ owner: 'a', repo: 'b', ref: '' })
  })

  test('an invalid address gives null', () => {
    expect(parseGithubRef('')).toBeNull()
    expect(parseGithubRef('just-text')).toBeNull()
    // Path characters in `owner` or `repo` — they must not leak into the API URL
    expect(parseGithubRef('../etc/passwd')).toBeNull()
    expect(parseGithubRef('a b/c')).toBeNull()
  })

  test('extra path segments are ignored', () => {
    // Segments that are not `tree`/`blob` give no ref, so `..` never reaches
    // the API request
    expect(parseGithubRef('a/b/../../etc')).toEqual({ owner: 'a', repo: 'b', ref: '' })
  })

  test('a `..` in the ref is rejected', () => {
    // The ref is appended to the URL — path traversal there is dangerous
    expect(parseGithubRef('https://github.com/a/b/tree/../../../etc')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('sources and the catalog', () => {
  test('a source is created and read back', () => {
    const s = createSkillSource(
      { kind: 'github', url: 'https://github.com/a/b', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )
    expect(readSkillSources(db)).toHaveLength(1)
    expect(s.owner).toBe('a')
  })

  test('connecting twice returns the existing one (not an error)', () => {
    const one = createSkillSource(
      { kind: 'github', url: 'https://github.com/a/b', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )
    const two = createSkillSource(
      { kind: 'github', url: 'another-url', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )
    expect(two.id).toBe(one.id)
    expect(readSkillSources(db)).toHaveLength(1)
  })

  test('syncing: added / updated / deleted', () => {
    const s = createSkillSource(
      { kind: 'github', url: 'u', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )

    const first = syncSkills(
      s.id,
      [
        { path: 'x/SKILL.md', name: 'x', description: 'X', warnings: [] },
        { path: 'y/SKILL.md', name: 'y', description: 'Y', warnings: [] },
      ],
      'sha1',
      db,
    )
    expect(first).toEqual({ added: 2, updated: 0, deleted: 0 })

    // `y` left the repo, `z` was added, `x` stayed
    const second = syncSkills(
      s.id,
      [
        { path: 'x/SKILL.md', name: 'x', description: 'X new', warnings: [] },
        { path: 'z/SKILL.md', name: 'z', description: 'Z', warnings: [] },
      ],
      'sha2',
      db,
    )
    expect(second).toEqual({ added: 1, updated: 1, deleted: 1 })
    expect(readSkills(db).find((s) => s.name === 'x')?.description).toBe('X new')
  })

  test('the install SURVIVES a sync — the id does not change', () => {
    const { source, skill } = sourceAndSkill()
    installSkill(skill.id, 'global', null, db)

    syncSkills(
      source.id,
      [{ path: skill.path, name: skill.name, description: 'new description', warnings: [] }],
      'sha2',
      db,
    )

    const after = readSkill(skill.id, db)
    expect(after?.description).toBe('new description')
    expect(after?.installs).toHaveLength(1) // the install was not lost
  })

  test('removing a source removes its skills too (CASCADE)', () => {
    const { source } = sourceAndSkill()
    expect(readSkills(db)).toHaveLength(1)

    deleteSkillSource(source.id, db)
    expect(readSkills(db)).toHaveLength(0)
  })

  test('allowedTools and warnings are stored', () => {
    const s = createSkillSource({ kind: 'github', url: 'u', owner: 'a', repo: 'b', ref: '' }, db)
    syncSkills(
      s.id,
      [
        {
          path: 'x/SKILL.md',
          name: 'x',
          description: 'X',
          allowedTools: ['read', 'bash'],
          warnings: ['the name does not match'],
        },
      ],
      null,
      db,
    )
    const skill = readSkills(db)[0]
    expect(skill?.allowedTools).toEqual(['read', 'bash'])
    expect(skill?.warnings).toEqual(['the name does not match'])
  })
})

// ---------------------------------------------------------------------------

describe('scope (installing)', () => {
  test('a global install', () => {
    const { skill } = sourceAndSkill()
    installSkill(skill.id, 'global', null, db)

    expect(readSkill(skill.id, db)?.installs).toEqual([{ scope: 'global', projectId: undefined }])
  })

  test('one skill installs into SEVERAL projects', () => {
    const { skill } = sourceAndSkill()
    const p1 = createProject('one', '/tmp/one', db)
    const p2 = createProject('two', '/tmp/two', db)

    installSkill(skill.id, 'project', p1.id, db)
    installSkill(skill.id, 'project', p2.id, db)

    expect(readSkill(skill.id, db)?.installs).toHaveLength(2)
  })

  test('installing twice is idempotent', () => {
    const { skill } = sourceAndSkill()
    installSkill(skill.id, 'global', null, db)
    installSkill(skill.id, 'global', null, db)

    expect(readSkill(skill.id, db)?.installs).toHaveLength(1)
  })

  test('uninstalling', () => {
    const { skill } = sourceAndSkill()
    installSkill(skill.id, 'global', null, db)
    expect(uninstallSkill(skill.id, 'global', null, db)).toBe(true)
    expect(readSkill(skill.id, db)?.installs).toEqual([])
  })

  test("activeSkills: the global ones plus the project's own", () => {
    const { skill: global } = sourceAndSkill('global-skill')
    const { skill: scoped } = sourceAndSkill('project-skill')
    const { skill: other } = sourceAndSkill('other-skill')

    const p1 = createProject('one', '/tmp/one', db)
    const p2 = createProject('two', '/tmp/two', db)

    installSkill(global.id, 'global', null, db)
    installSkill(scoped.id, 'project', p1.id, db)
    installSkill(other.id, 'project', p2.id, db)

    const active = activeSkills(p1.id, db).map((s) => s.name).sort()
    expect(active).toEqual(['global-skill', 'project-skill'])
  })

  test('a session without a project sees only the global ones', () => {
    const { skill: global } = sourceAndSkill('global-skill')
    const { skill: scoped } = sourceAndSkill('project-skill')
    const p1 = createProject('one', '/tmp/one', db)

    installSkill(global.id, 'global', null, db)
    installSkill(scoped.id, 'project', p1.id, db)

    expect(activeSkills(null, db).map((s) => s.name)).toEqual(['global-skill'])
  })

  test('a skill that is not installed is not active', () => {
    sourceAndSkill()
    expect(activeSkills(null, db)).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('syncToProject — disk', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'work-'))
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  /** Puts skill files into the store (imitating the result of an install) */
  function writeToStore(sourceId: string, skillId: string, content: string) {
    const path = skillStorePath(sourceId, skillId)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), content)
  }

  test('it is COPIED from the store into the working directory (not symlinked)', () => {
    const { source, skill } = sourceAndSkill()
    writeToStore(source.id, skill.id, '---\nname: pdf-fill\ndescription: t\n---')

    const result = syncToProject(work, [skill])
    expect(result.copied).toBe(1)

    const target = join(work, WORK_SKILL_DIR, 'pdf-fill', 'SKILL.md')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('pdf-fill')
  })

  test('the copy is independent — editing it in the working directory does not touch the store', () => {
    // With a symlink this test would fail: an agent in one project would
    // damage the original in the store and harm every project
    const { source, skill } = sourceAndSkill()
    writeToStore(source.id, skill.id, 'ORIGINAL')
    syncToProject(work, [skill])

    writeFileSync(join(work, WORK_SKILL_DIR, 'pdf-fill', 'SKILL.md'), 'DAMAGED')

    const storeFile = join(skillStorePath(source.id, skill.id), 'SKILL.md')
    expect(readFileSync(storeFile, 'utf8')).toBe('ORIGINAL')
  })

  test('a skill that is not in the database is DELETED from disk', () => {
    const { source, skill } = sourceAndSkill()
    writeToStore(source.id, skill.id, 'x')
    syncToProject(work, [skill])
    expect(existsSync(join(work, WORK_SKILL_DIR, 'pdf-fill'))).toBe(true)

    // The skill is no longer installed — the sync must take it away
    const result = syncToProject(work, [])
    expect(result.deleted).toBe(1)
    expect(existsSync(join(work, WORK_SKILL_DIR, 'pdf-fill'))).toBe(false)
  })

  test('a hand-placed directory is deleted too — the directory IS MANAGED', () => {
    mkdirSync(join(work, WORK_SKILL_DIR, 'homemade'), { recursive: true })
    const result = syncToProject(work, [])
    expect(result.deleted).toBe(1)
    expect(existsSync(join(work, WORK_SKILL_DIR, 'homemade'))).toBe(false)
  })

  test('when the store is updated the copy is updated too', () => {
    const { source, skill } = sourceAndSkill()
    writeToStore(source.id, skill.id, 'OLD')
    syncToProject(work, [skill])

    writeToStore(source.id, skill.id, 'NEW')
    syncToProject(work, [skill])

    expect(readFileSync(join(work, WORK_SKILL_DIR, 'pdf-fill', 'SKILL.md'), 'utf8')).toBe('NEW')
  })

  test('a skill missing from the store is skipped silently', () => {
    const { skill } = sourceAndSkill()
    // nothing was written to the store
    const result = syncToProject(work, [skill])
    expect(result.copied).toBe(0)
  })

  test('nested directories are copied too (scripts/ and so on)', () => {
    const { source, skill } = sourceAndSkill()
    const storePath = skillStorePath(source.id, skill.id)
    mkdirSync(join(storePath, 'scripts'), { recursive: true })
    writeFileSync(join(storePath, 'SKILL.md'), 'x')
    writeFileSync(join(storePath, 'scripts', 'run.sh'), 'echo hi')

    syncToProject(work, [skill])

    expect(existsSync(join(work, WORK_SKILL_DIR, 'pdf-fill', 'scripts', 'run.sh'))).toBe(true)
  })

  test('a dangerous name does not become a directory name', () => {
    const { source, skill } = sourceAndSkill()
    writeToStore(source.id, skill.id, 'x')

    // Even if the name in the database is `../../evil`, the directory must not
    // escape the working directory
    const evil = { ...skill, name: '../../evil' }
    syncToProject(work, [evil])

    expect(existsSync(join(work, '..', '..', 'evil'))).toBe(false)
  })
})
