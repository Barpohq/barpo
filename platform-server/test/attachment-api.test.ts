// The attachment routes: uploading (multipart), serving (binary) and removing.
//
// The file system lives in a temporary directory — `PLATFORM_WORKS` is pointed
// at it, so the real works root under the home directory is never touched.
//
// Two security rules are the focus:
//   1) THE KIND COMES FROM THE CONTENT — a ZIP called `.png` must not be an
//      image, otherwise its `content-type` would be handed to the browser on
//      trust;
//   2) A FILE is never served `inline` — that is the stored-XSS route.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatAttachment } from '@platforma/shared'
import { app } from '../src/app.ts'
import { openDb, setDb } from '../src/db.ts'
import { FILES_DIR, SESSION_DIR } from '../src/work-dir.ts'
import { readAttachment, createSession, writeMessage } from '../src/repo.ts'
import { linkAttachmentsToMessage } from '../src/repo.ts'

let db: Database
let tempDir: string
let previousWorks: string | undefined

// Real signatures — `imageKind` checks exactly these
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)

  tempDir = mkdtempSync(join(tmpdir(), 'platform-attachment-api-'))
  previousWorks = process.env.PLATFORM_WORKS
  process.env.PLATFORM_WORKS = join(tempDir, 'works')
})

afterEach(() => {
  setDb(null)
  db.close()

  if (previousWorks === undefined) delete process.env.PLATFORM_WORKS
  else process.env.PLATFORM_WORKS = previousWorks

  rmSync(tempDir, { recursive: true, force: true })
})

async function upload(
  sessionId: string | undefined,
  files: { name: string; bytes: Uint8Array; type?: string }[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData()
  if (sessionId !== undefined) form.set('sessionId', sessionId)
  for (const f of files) {
    form.append('file', new File([f.bytes], f.name, { type: f.type ?? 'application/octet-stream' }))
  }
  const response = await app.request('/api/chat/attachment', { method: 'POST', body: form })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** The list of files in the session folder */
function filesInDir(sessionId: string): string[] {
  const path = join(
    process.env.PLATFORM_WORKS!,
    sessionId,
    SESSION_DIR,
    sessionId,
    FILES_DIR,
  )
  return existsSync(path) ? readdirSync(path) : []
}

describe('POST /chat/attachment', () => {
  test('a PNG uploads — kind "image", the file is on disk', async () => {
    const session = createSession('test')
    const { status, body } = await upload(session.id, [{ name: 'picture.png', bytes: PNG }])

    expect(status).toBe(201)
    const attachments = body.attachments as ChatAttachment[]
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.kind).toBe('image')
    expect(attachments[0]!.mime).toBe('image/png')
    expect(attachments[0]!.originalName).toBe('picture.png')
    expect(filesInDir(session.id)).toEqual(['picture.png'])
  })

  test('a ZIP uploads — kind "file", mime octet-stream', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [{ name: 'archive.zip', bytes: ZIP }])

    const attachments = body.attachments as ChatAttachment[]
    expect(attachments[0]!.kind).toBe('file')
    expect(attachments[0]!.mime).toBe('application/octet-stream')
  })

  // The most important case: both the extension and the client-supplied mime lie
  test('a ZIP called ".png" becomes a "file", it does not quietly become an image', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [
      { name: 'decoy.png', bytes: ZIP, type: 'image/png' },
    ])

    const attachments = body.attachments as ChatAttachment[]
    expect(attachments[0]!.kind).toBe('file')
    expect(attachments[0]!.mime).toBe('application/octet-stream')
  })

  test('a client-supplied "text/html" is not stored', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [
      {
        name: 'harmful.html',
        bytes: new TextEncoder().encode('<script>alert(1)</script>'),
        type: 'text/html',
      },
    ])

    expect((body.attachments as ChatAttachment[])[0]!.mime).toBe('application/octet-stream')
  })

  test('several files in one request', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [
      { name: 'a.png', bytes: PNG },
      { name: 'b.zip', bytes: ZIP },
    ])

    expect(body.attachments as ChatAttachment[]).toHaveLength(2)
    expect(filesInDir(session.id).sort()).toEqual(['a.png', 'b.zip'])
  })

  test('a second file with the same name is stored with -2', async () => {
    const session = createSession('test')
    await upload(session.id, [{ name: 'a.png', bytes: PNG }])
    await upload(session.id, [{ name: 'a.png', bytes: PNG }])

    expect(filesInDir(session.id).sort()).toEqual(['a-2.png', 'a.png'])
  })

  test('an image with an empty name gets a fallback name (a Windows paste)', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [{ name: '', bytes: PNG }])

    const attachments = body.attachments as ChatAttachment[]
    expect(attachments[0]!.path.endsWith('image.png')).toBe(true)
  })

  test('an attempt to escape the path leaves nothing outside the folder', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [{ name: '../../escaped.png', bytes: PNG }])

    const attachments = body.attachments as ChatAttachment[]
    expect(attachments[0]!.path).not.toContain('..')
    expect(filesInDir(session.id)).toEqual(['escaped.png'])
  })

  test('no sessionId — 400', async () => {
    const { status, body } = await upload(undefined, [{ name: 'a.png', bytes: PNG }])

    expect(status).toBe(400)
    expect(body.error).toContain('sessionId')
  })

  test('a session that does not exist — 404', async () => {
    const { status } = await upload('no-such-session', [{ name: 'a.png', bytes: PNG }])

    expect(status).toBe(404)
  })

  test('no file sent — 400', async () => {
    const session = createSession('test')
    const { status, body } = await upload(session.id, [])

    expect(status).toBe(400)
    expect(body.error).toContain('file')
  })

  test('an empty file — 400', async () => {
    const session = createSession('test')
    const { status } = await upload(session.id, [{ name: 'a.txt', bytes: new Uint8Array([]) }])

    expect(status).toBe(400)
  })

  test('a body that is not multipart — 400', async () => {
    const response = await app.request('/api/chat/attachment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x' }),
    })

    expect(response.status).toBe(400)
  })

  test('going over the count limit — 400', async () => {
    const session = createSession('test')
    // The default limit is 10
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `a${i}.png`, bytes: PNG }))
    const { status, body } = await upload(session.id, files)

    expect(status).toBe(400)
    expect(body.error).toContain('limit')
  })
})

describe('GET /chat/attachment/:id', () => {
  test('an image comes back with its real mime, inline', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [{ name: 'picture.png', bytes: PNG }])
    const id = (body.attachments as ChatAttachment[])[0]!.id

    const response = await app.request(`/api/chat/attachment/${id}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toContain('inline')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })

  // XSS protection: a file must not open as a page in the browser
  test('a file comes back as octet-stream, as an attachment', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [
      { name: 'harmful.html', bytes: new TextEncoder().encode('<script>alert(1)</script>') },
    ])
    const id = (body.attachments as ChatAttachment[])[0]!.id

    const response = await app.request(`/api/chat/attachment/${id}`)

    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment')
  })

  test('an unknown id — 404', async () => {
    const response = await app.request('/api/chat/attachment/no-such')

    expect(response.status).toBe(404)
  })
})

describe('DELETE /chat/attachment/:id', () => {
  test('an unsent attachment loses its file along with its record', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [{ name: 'a.png', bytes: PNG }])
    const id = (body.attachments as ChatAttachment[])[0]!.id

    const response = await app.request(`/api/chat/attachment/${id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(readAttachment(id)).toBeNull()
    expect(filesInDir(session.id)).toEqual([])
  })

  // Rewriting history backwards would create a false context
  test('an attachment linked to a message is not removed — 409', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [{ name: 'a.png', bytes: PNG }])
    const id = (body.attachments as ChatAttachment[])[0]!.id
    const message = writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    linkAttachmentsToMessage(session.id, message.id, [id])

    const response = await app.request(`/api/chat/attachment/${id}`, { method: 'DELETE' })

    expect(response.status).toBe(409)
    expect(readAttachment(id)).not.toBeNull()
    expect(filesInDir(session.id)).toEqual(['a.png'])
  })

  test('an unknown id — 404', async () => {
    const response = await app.request('/api/chat/attachment/no-such', { method: 'DELETE' })

    expect(response.status).toBe(404)
  })
})

describe('DELETE /chat/sessions/:id — clearing the files', () => {
  test('deleting the session takes the upload folder off the disk', async () => {
    const session = createSession('test')
    await upload(session.id, [{ name: 'a.png', bytes: PNG }])
    expect(filesInDir(session.id)).toEqual(['a.png'])

    const response = await app.request(`/api/chat/sessions/${session.id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(filesInDir(session.id)).toEqual([])
  })

  test('a session with no attachments deletes just as cleanly', async () => {
    const session = createSession('test')

    const response = await app.request(`/api/chat/sessions/${session.id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
  })
})

describe('restoring from the history', () => {
  test('a linked attachment comes back with its message', async () => {
    const session = createSession('test')
    const { body } = await upload(session.id, [{ name: 'a.png', bytes: PNG }])
    const id = (body.attachments as ChatAttachment[])[0]!.id
    const message = writeMessage({ sessionId: session.id, role: 'user', text: 'what is this?' })
    linkAttachmentsToMessage(session.id, message.id, [id])

    const response = await app.request(`/api/chat/sessions/${session.id}/messages`)
    const payload = (await response.json()) as { messages: { attachments?: ChatAttachment[] }[] }

    expect(payload.messages[0]?.attachments).toHaveLength(1)
    expect(payload.messages[0]?.attachments?.[0]?.originalName).toBe('a.png')
  })
})
