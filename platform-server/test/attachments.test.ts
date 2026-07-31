// The DATABASE layer for attachments: migration 012, the repo functions and
// the way they hook into `readMessages()`. Neither the file system nor HTTP
// takes part here.
//
// The focus is the NULL `message_id` case. It is what makes this table unusual:
// the record appears BEFORE the message, so "not linked yet" is a normal state.
// That is why the tests press on exactly that boundary.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb, setDb } from '../src/db.ts'
import {
  readAttachmentsByIds,
  linkAttachmentsToMessage,
  deleteAttachment,
  readAttachment,
  writeAttachment,
  sessionAttachments,
  deleteSession,
  createSession,
  readMessages,
  writeMessage,
  deleteOrphanAttachments,
} from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
})

afterEach(() => {
  setDb(null)
  db.close()
})

/** An attachment for the tests — only the fields that differ are passed in */
function write(
  sessionId: string,
  changes: Partial<Parameters<typeof writeAttachment>[0]> = {},
) {
  return writeAttachment({
    sessionId,
    kind: 'file',
    name: 'a.txt',
    originalName: 'a.txt',
    path: '.platforma/sessiyalar/s/fayllar/a.txt',
    mime: 'text/plain',
    size: 10,
    ...changes,
  })
}

describe('migration 012', () => {
  test('the chat_attachments table and its columns exist', () => {
    const columns = db
      .query<{ name: string; notnull: number }, []>('PRAGMA table_info(chat_attachments)')
      .all()

    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'session_id',
      'message_id',
      'kind',
      'name',
      'original_name',
      'path',
      'mime',
      'size',
      'created_at',
    ])
  })

  test('message_id may be NULL — the record appears before the message', () => {
    const column = db
      .query<{ name: string; notnull: number }, []>('PRAGMA table_info(chat_attachments)')
      .all()
      .find((c) => c.name === 'message_id')

    expect(column?.notnull).toBe(0)
  })

  test('the indexes have been created', () => {
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_attachments'",
      )
      .all()
      .map((i) => i.name)

    expect(indexes).toContain('idx_chat_attachments_message')
    expect(indexes).toContain('idx_chat_attachments_session')
  })
})

describe('writeAttachment / readAttachment', () => {
  test('a written attachment can be read back', () => {
    const session = createSession('test')
    const written = write(session.id, { kind: 'image', mime: 'image/png', size: 2048 })

    const read = readAttachment(written.id)
    expect(read).not.toBeNull()
    expect(read!.kind).toBe('image')
    expect(read!.mime).toBe('image/png')
    expect(read!.size).toBe(2048)
    expect(read!.sessionId).toBe(session.id)
  })

  test('the name on disk does not show up in the external type', () => {
    const session = createSession('test')
    const written = write(session.id, { name: 'sanitised.txt', originalName: 'real name!.txt' })

    expect(written.originalName).toBe('real name!.txt')
    expect(written as unknown as Record<string, unknown>).not.toHaveProperty('name')
  })

  test('null for an attachment that does not exist', () => {
    expect(readAttachment('no-such-id')).toBeNull()
  })

  test('it can be written already linked to a messageId', () => {
    const session = createSession('test')
    const message = writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    write(session.id, { messageId: message.id })

    const messages = readMessages(session.id)
    expect(messages[0]?.attachments).toHaveLength(1)
  })
})

describe('readAttachmentsByIds', () => {
  test('they come back in the order they were asked for', () => {
    const session = createSession('test')
    const one = write(session.id, { originalName: 'one.txt' })
    const two = write(session.id, { originalName: 'two.txt' })

    const reversed = readAttachmentsByIds(session.id, [two.id, one.id])
    expect(reversed.map((a) => a.originalName)).toEqual(['two.txt', 'one.txt'])
  })

  // SECURITY: the client can send any id it likes on `chat.send`
  test("another session's attachment is not returned", () => {
    const one = createSession('one')
    const two = createSession('two')
    const foreign = write(two.id)

    expect(readAttachmentsByIds(one.id, [foreign.id])).toHaveLength(0)
  })

  test('an unknown id is dropped silently — the caller checks the count', () => {
    const session = createSession('test')
    const existing = write(session.id)

    const result = readAttachmentsByIds(session.id, [existing.id, 'no-such'])
    expect(result).toHaveLength(1)
  })

  test('an empty list gives an empty result', () => {
    const session = createSession('test')
    expect(readAttachmentsByIds(session.id, [])).toEqual([])
  })
})

describe('linkAttachmentsToMessage', () => {
  test('unlinked records move onto the message', () => {
    const session = createSession('test')
    const one = write(session.id)
    const two = write(session.id)
    const message = writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })

    const count = linkAttachmentsToMessage(session.id, message.id, [one.id, two.id])

    expect(count).toBe(2)
    expect(readMessages(session.id)[0]?.attachments).toHaveLength(2)
  })

  // Protection against a repeated send: once a file belongs to a message it
  // does not move
  test('an already linked record does not move to a second message', () => {
    const session = createSession('test')
    const attachment = write(session.id)
    const first = writeMessage({ sessionId: session.id, role: 'user', text: 'one' })
    const second = writeMessage({ sessionId: session.id, role: 'user', text: 'two' })

    linkAttachmentsToMessage(session.id, first.id, [attachment.id])
    const count = linkAttachmentsToMessage(session.id, second.id, [attachment.id])

    expect(count).toBe(0)
    const messages = readMessages(session.id)
    expect(messages.find((m) => m.id === first.id)?.attachments).toHaveLength(1)
    expect(messages.find((m) => m.id === second.id)?.attachments).toBeUndefined()
  })

  test("another session's record is not linked", () => {
    const one = createSession('one')
    const two = createSession('two')
    const foreign = write(two.id)
    const message = writeMessage({ sessionId: one.id, role: 'user', text: 'hello' })

    expect(linkAttachmentsToMessage(one.id, message.id, [foreign.id])).toBe(0)
  })
})

describe('integration with readMessages', () => {
  test('a NULL message_id record IS NOT VISIBLE in the history', () => {
    const session = createSession('test')
    writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    write(session.id) // unlinked

    const messages = readMessages(session.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.attachments).toBeUndefined()
  })

  // Unlike tool calls: NO synthetic message is built for an orphan
  test('an unlinked attachment does not create a synthetic message', () => {
    const session = createSession('test')
    write(session.id)

    expect(readMessages(session.id)).toHaveLength(0)
  })

  test('attachments arrive in upload order', () => {
    const session = createSession('test')
    const message = writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    write(session.id, { originalName: 'one.txt', messageId: message.id })
    write(session.id, { originalName: 'two.txt', messageId: message.id })

    const attachments = readMessages(session.id)[0]?.attachments
    expect(attachments?.map((a) => a.originalName)).toEqual(['one.txt', 'two.txt'])
  })

  test('a conversation with no attachments reads back unchanged', () => {
    const session = createSession('test')
    writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    writeMessage({ sessionId: session.id, role: 'assistant', text: 'reply' })

    const messages = readMessages(session.id)
    expect(messages).toHaveLength(2)
    expect(messages.every((m) => m.attachments === undefined)).toBe(true)
  })
})

describe('deletion', () => {
  test('deleteAttachment removes the record', () => {
    const session = createSession('test')
    const attachment = write(session.id)

    expect(deleteAttachment(attachment.id)).toBe(true)
    expect(readAttachment(attachment.id)).toBeNull()
  })

  test('deleting a record that does not exist returns false', () => {
    expect(deleteAttachment('no-such')).toBe(false)
  })

  test('deleting the session takes it with it via CASCADE', () => {
    const session = createSession('test')
    const attachment = write(session.id)

    deleteSession(session.id)

    expect(readAttachment(attachment.id)).toBeNull()
  })
})

describe('deleteOrphanAttachments', () => {
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  test('an old, unlinked record is deleted and returned', () => {
    const session = createSession('test')
    const orphan = write(session.id, { createdAt: oldTime })

    const deleted = deleteOrphanAttachments(session.id)

    expect(deleted.map((a) => a.id)).toEqual([orphan.id])
    expect(readAttachment(orphan.id)).toBeNull()
  })

  test('a recent record is kept — the user may still have the chip in view', () => {
    const session = createSession('test')
    const recent = write(session.id)

    expect(deleteOrphanAttachments(session.id)).toEqual([])
    expect(readAttachment(recent.id)).not.toBeNull()
  })

  test('an old record that is linked to a message is kept', () => {
    const session = createSession('test')
    const message = writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    const linked = write(session.id, { createdAt: oldTime, messageId: message.id })

    expect(deleteOrphanAttachments(session.id)).toEqual([])
    expect(readAttachment(linked.id)).not.toBeNull()
  })

  test("another session's orphan is left alone", () => {
    const one = createSession('one')
    const two = createSession('two')
    const foreign = write(two.id, { createdAt: oldTime })

    expect(deleteOrphanAttachments(one.id)).toEqual([])
    expect(readAttachment(foreign.id)).not.toBeNull()
  })
})

describe('sessionAttachments', () => {
  test('linked and unlinked come back together — for clearing the folder', () => {
    const session = createSession('test')
    const message = writeMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    write(session.id, { originalName: 'linked.txt', messageId: message.id })
    write(session.id, { originalName: 'loose.txt' })

    expect(sessionAttachments(session.id)).toHaveLength(2)
  })
})
