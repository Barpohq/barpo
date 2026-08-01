// WHICH directory the orchestrator hands to a session attached to a project.
//
// `projects.test.ts` exercises `sessionWorkDir` on its own; here the FULL
// CHAIN is checked:
//   session (with a project_id) → repo → orchestrator → agentStream options
//
// Why a separate file: the `mock.module` in `orchestrator.test.ts` is global
// and changing an existing test is off limits. The pattern is repeated here.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The options the stream function was last called with */
let lastOptions: { workDir?: string; sessionId?: string } | null = null

// CAREFUL: mock.module replaces the whole module — we keep the real exports
// and only write over the ones we need (see the comment in
// orchestrator.test.ts).
const realAi = await import('@barpo/ai')
const realPermissionManager = realAi.permissionManager
const watched = new WeakSet<object>()

function denyingPermissionManager(sessionId: string) {
  const manager = realPermissionManager(sessionId)
  if (!watched.has(manager)) {
    watched.add(manager)
    manager.subscribe((request) => manager.answer(request.id, 'deny'))
  }
  return manager
}

mock.module('@barpo/ai', () => ({
  ...realAi,
  agentStream: async function* (_choice: unknown, _messages: unknown, options: unknown) {
    lastOptions = options as { workDir?: string; sessionId?: string }
    yield { kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }
  },
  permissionManager: denyingPermissionManager,
}))

const { openDb, setDb } = await import('../src/db.ts')
const { streamReply } = await import('../src/orchestrator.ts')
const { createProjectDir } = await import('../src/work-dir.ts')
const { createProject, createSession } = await import('../src/repo.ts')
const { hub } = await import('../src/ws/hub.ts')

let db: Database
let tempRoot: string

const choice = { provider: 'ollama', model: 'qwen3:0.6b' }

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'project-dir-'))
  process.env.PLATFORM_WORKS = join(tempRoot, 'works')
  process.env.PLATFORM_PROJECTS = join(tempRoot, 'projects')

  db = openDb(':memory:')
  setDb(db)
  lastOptions = null
})

afterEach(() => {
  delete process.env.PLATFORM_WORKS
  delete process.env.PLATFORM_PROJECTS
  rmSync(tempRoot, { recursive: true, force: true })
  setDb(null)
  hub.clear()
  db.close()
})

describe('streamReply — the project directory', () => {
  test('a session with no project runs in its own session directory', async () => {
    const session = createSession('no project', db)
    await streamReply(session.id, 'x1', choice)

    expect(lastOptions?.workDir).toContain(join(tempRoot, 'works'))
    expect(lastOptions?.workDir).toContain(session.id)
  })

  test('a session with a project runs in the PROJECT directory', async () => {
    const dir = createProjectDir('bot')
    const project = createProject('bot', dir, db)
    const session = createSession('attached', db, project.id)

    await streamReply(session.id, 'x2', choice)

    expect(lastOptions?.workDir).toBe(dir)
    // The session id plays no part in the directory path at all
    expect(lastOptions?.workDir).not.toContain(session.id)
    expect(lastOptions?.sessionId).toBe(session.id)
  })

  test('TWO sessions of one project share a single directory', async () => {
    const dir = createProjectDir('shared')
    const project = createProject('shared', dir, db)
    const first = createSession('chat 1', db, project.id)
    const second = createSession('chat 2', db, project.id)

    await streamReply(first.id, 'x3', choice)
    const firstDir = lastOptions?.workDir

    await streamReply(second.id, 'x4', choice)
    const secondDir = lastOptions?.workDir

    expect(firstDir).toBe(dir)
    expect(secondDir).toBe(dir)
  })

  test('two different projects run in two different directories (isolation)', async () => {
    const one = createProject('one', createProjectDir('one'), db)
    const two = createProject('two', createProjectDir('two'), db)

    await streamReply(createSession('a', db, one.id).id, 'x5', choice)
    const oneDir = lastOptions?.workDir

    await streamReply(createSession('b', db, two.id).id, 'x6', choice)

    expect(oneDir).not.toBe(lastOptions?.workDir)
  })

  test('a project directory deleted by hand is recreated', async () => {
    const dir = createProjectDir('deleted')
    const project = createProject('deleted', dir, db)
    const session = createSession('chat', db, project.id)

    rmSync(dir, { recursive: true, force: true })
    await streamReply(session.id, 'x7', choice)

    expect(lastOptions?.workDir).toBe(dir)
    expect(existsSync(dir)).toBe(true)
  })
})
