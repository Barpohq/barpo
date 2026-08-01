// Projects (project / workspace): migration 005, the routes, binding a
// session and the work-directory selection logic.
//
// The tests that touch the file system work inside a temporary folder — the
// `PLATFORM_PROJECTS` env var points there, so the real
// `~/.barpo/loyihalar` is never touched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSession, Project } from '@barpo/shared'
import { app } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import {
  workDir,
  createProjectDir,
  projectsRoot,
  projectSlug,
  sessionWorkDir,
} from '../src/work-dir.ts'
import {
  projectByName,
  readProject,
  readProjects,
  createProject,
  sessionProjectDir,
  readSession,
  readSessions,
  createSession,
} from '../src/repo.ts'

let db: Database
let temp: string
let oldProjects: string | undefined
let oldWorks: string | undefined

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)

  temp = mkdtempSync(join(tmpdir(), 'barpo-loyiha-'))
  oldProjects = process.env.PLATFORM_PROJECTS
  oldWorks = process.env.PLATFORM_WORKS
  process.env.PLATFORM_PROJECTS = join(temp, 'projects')
  process.env.PLATFORM_WORKS = join(temp, 'works')
})

afterEach(() => {
  setDb(null)
  db.close()

  if (oldProjects === undefined) delete process.env.PLATFORM_PROJECTS
  else process.env.PLATFORM_PROJECTS = oldProjects
  if (oldWorks === undefined) delete process.env.PLATFORM_WORKS
  else process.env.PLATFORM_WORKS = oldWorks

  rmSync(temp, { recursive: true, force: true })
})

async function requestProject(name: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

// ---------------------------------------------------------------------------

describe('migration 005 — the projects schema', () => {
  test('the projects table is created with the expected columns', () => {
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(projects)')
      .all()
      .map((c) => c.name)
    expect(columns).toEqual(['id', 'name', 'folder', 'created_at'])
  })

  test('a project_id column is added to chat_sessions', () => {
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_sessions)')
      .all()
      .map((c) => c.name)
    expect(columns).toContain('project_id')
  })

  test('the project name is UNIQUE — the same name cannot be written twice', () => {
    db.prepare('INSERT INTO projects (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(
      'a',
      'same name',
      '/tmp/a',
      '2026-07-28T10:00:00.000Z',
    )
    expect(() =>
      db.prepare('INSERT INTO projects (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(
        'b',
        'same name',
        '/tmp/b',
        '2026-07-28T10:00:01.000Z',
      ),
    ).toThrow()
  })

  test('a session bound to a project that does not exist is rejected (foreign key)', () => {
    expect(() =>
      db
        .prepare(
          'INSERT INTO chat_sessions (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('s1', 'test', 'no-such-project', '2026-07-28T10:00:00.000Z', '2026-07-28T10:00:00.000Z'),
    ).toThrow()
  })

  test('an older session (project_id NULL) still reads fine', () => {
    const s = createSession('project-less', db)
    expect(s.projectId).toBeUndefined()
    expect(readSession(s.id, db)?.projectId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('projectSlug — the safety of the folder name', () => {
  test('an ordinary name is left alone', () => {
    expect(projectSlug('bot')).toBe('bot')
    expect(projectSlug('my_project-2')).toBe('my_project-2')
  })

  test('spaces become hyphens', () => {
    expect(projectSlug('my project')).toBe('my-project')
  })

  test('path tricks never reach the folder name', () => {
    // The most important check: a slug must not be able to escape the root
    for (const dangerous of ['../../etc', '..', '/etc/passwd', 'a/../../b', './..']) {
      const slug = projectSlug(dangerous)
      if (slug !== null) {
        expect(slug).not.toContain('/')
        expect(slug).not.toContain('..')
        expect(slug).toMatch(/^[a-zA-Z0-9_-]+$/)
      }
    }
  })

  test('a name made only of dots and slashes returns null', () => {
    expect(projectSlug('..')).toBeNull()
    expect(projectSlug('///')).toBeNull()
    expect(projectSlug('...')).toBeNull()
  })

  test('a name with no latin characters (emoji, cyrillic) returns null', () => {
    expect(projectSlug('🚀🚀')).toBeNull()
    expect(projectSlug('проект')).toBeNull()
    expect(projectSlug('   ')).toBeNull()
  })

  test('NUL and other special characters are stripped', () => {
    const slug = projectSlug('bot\0malicious')
    expect(slug).toBe('bot-malicious')
  })

  test('an overlong name is truncated', () => {
    const slug = projectSlug('a'.repeat(200))
    expect(slug?.length).toBe(60)
  })

  test('the result only ever contains safe characters', () => {
    for (const name of ['a b/c', 'x@y.z', "name'with", 'tab\there', 'new\nline']) {
      const slug = projectSlug(name)
      if (slug !== null) expect(slug).toMatch(/^[a-zA-Z0-9_-]+$/)
    }
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/projects', () => {
  test('the project is created and its folder really appears on disk', async () => {
    const { status, body } = await requestProject('My bot')
    expect(status).toBe(201)

    const project = body.project as Project
    expect(project.name).toBe('My bot')
    expect(project.folder).toBe(join(projectsRoot(), 'My-bot'))
    expect(existsSync(project.folder)).toBe(true)
  })

  test('the folder stays inside the PLATFORM_PROJECTS root', async () => {
    const { body } = await requestProject('../escape attempt')
    const project = body.project as Project
    expect(project.folder.startsWith(projectsRoot())).toBe(true)
    expect(project.folder).not.toContain('..')
  })

  test('an empty name gives a 400', async () => {
    expect((await requestProject('')).status).toBe(400)
    expect((await requestProject('   ')).status).toBe(400)
    expect((await requestProject(42)).status).toBe(400)
  })

  test('a name yielding no folder name gives a 400 and creates no row', async () => {
    const { status } = await requestProject('🚀')
    expect(status).toBe(400)
    expect(readProjects(db)).toHaveLength(0)
  })

  test('a duplicate name gives a 409 and no second row is created', async () => {
    expect((await requestProject('duplicate')).status).toBe(201)
    const second = await requestProject('duplicate')
    expect(second.status).toBe(409)
    expect(readProjects(db)).toHaveLength(1)
  })

  test('an overlong name gives a 400', async () => {
    expect((await requestProject('n'.repeat(200))).status).toBe(400)
  })

  test('a body that is not JSON gives a 400', async () => {
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'malformed',
    })
    expect(response.status).toBe(400)
  })
})

describe('GET /api/projects', () => {
  test('an empty list', async () => {
    const response = await app.request('/api/projects')
    expect(response.status).toBe(200)
    expect((await response.json()) as { projects: Project[] }).toEqual({ projects: [] })
  })

  test('each project comes back with its chat count', async () => {
    const one = createProject('one', createProjectDir('one'), db)
    createProject('two', createProjectDir('two'), db)
    createSession('chat 1', db, one.id)
    createSession('chat 2', db, one.id)
    // A session with no project counts towards no project at all
    createSession('chat 3', db)

    const response = await app.request('/api/projects')
    const { projects } = (await response.json()) as { projects: Project[] }

    expect(projects).toHaveLength(2)
    expect(projects.find((p) => p.name === 'one')?.chatCount).toBe(2)
    expect(projects.find((p) => p.name === 'two')?.chatCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('repo — projects', () => {
  test('readProject and projectByName', () => {
    const p = createProject('name', '/tmp/name', db)
    expect(readProject(p.id, db)?.name).toBe('name')
    expect(projectByName('name', db)?.id).toBe(p.id)
    expect(readProject('no-such-id', db)).toBeNull()
    expect(projectByName('no-such-name', db)).toBeNull()
  })

  test('sessionProjectDir gives the folder of a bound session', () => {
    const p = createProject('bound', '/tmp/bound', db)
    const s = createSession('chat', db, p.id)
    expect(sessionProjectDir(s.id, db)).toBe('/tmp/bound')
  })

  test('it returns null for a project-less or missing session', () => {
    const s = createSession('project-less', db)
    expect(sessionProjectDir(s.id, db)).toBeNull()
    expect(sessionProjectDir('no-such-session', db)).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/chat/sessions — binding to a project', () => {
  test('a session created with a projectId is bound to that project', async () => {
    const p = createProject('with-chats', createProjectDir('with-chats'), db)

    const response = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'bound', projectId: p.id }),
    })
    expect(response.status).toBe(201)

    const { session } = (await response.json()) as { session: ChatSession }
    expect(session.projectId).toBe(p.id)
    // It shows up in the session list and on a direct read too
    expect(readSession(session.id, db)?.projectId).toBe(p.id)
    expect(readSessions(db)[0]?.projectId).toBe(p.id)
  })

  test('without a projectId the session stays project-less', async () => {
    const response = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'alone' }),
    })
    const { session } = (await response.json()) as { session: ChatSession }
    expect(session.projectId).toBeUndefined()
  })

  test('a projectId that does not exist gives a 404 (not a 500)', async () => {
    const response = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'bad', projectId: 'no-such-project' }),
    })
    expect(response.status).toBe(404)
    expect(readSessions(db)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('sessionWorkDir — which folder the session runs in', () => {
  test('a project-less session stays in its own folder', () => {
    const path = sessionWorkDir('session-1', null)
    expect(path).toBe(workDir('session-1'))
    expect(path.startsWith(join(temp, 'works'))).toBe(true)
  })

  test('undefined counts as project-less too', () => {
    expect(sessionWorkDir('session-2')).toBe(workDir('session-2'))
  })

  test('a session with a project takes the project folder', () => {
    const projectPath = createProjectDir('my-project')
    expect(sessionWorkDir('session-3', projectPath)).toBe(projectPath)
  })

  test('two sessions of one project share A SINGLE folder', () => {
    // The heart of the concept: every chat inside a project sees the same set
    // of files (concurrent collisions are an accepted risk)
    const projectPath = createProjectDir('shared')
    expect(sessionWorkDir('a', projectPath)).toBe(sessionWorkDir('b', projectPath))
  })

  test('a deleted project folder is recreated', () => {
    const projectPath = createProjectDir('deleted')
    rmSync(projectPath, { recursive: true, force: true })
    expect(existsSync(projectPath)).toBe(false)

    expect(sessionWorkDir('session-4', projectPath)).toBe(projectPath)
    expect(existsSync(projectPath)).toBe(true)
  })

  test('two different projects get two different folders', () => {
    const one = createProjectDir('one')
    const two = createProjectDir('two')
    expect(one).not.toBe(two)
  })
})
