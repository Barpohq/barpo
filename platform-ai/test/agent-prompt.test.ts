// Picking the prompt — the case where the history ends with an `assistant`.
//
// WHY THIS TEST EXISTS (a real race condition):
//   1) the user sent a message and the answer is streaming;
//   2) they pressed "Stop" and immediately sent a new message;
//   3) `streamReply` aborted the old stream and wrote the NEW user message;
//   4) the aborted old stream saved its own answer in `finally` ONLY THEN —
//      that is, AFTER the new user message.
//
// The history is then left as `user, user, assistant`. Previously the
// `messages.at(-1)?.role === 'user'` check failed in this situation and the
// agent produced a "No user message found to send" error, so the user's
// message was SILENTLY lost.

import { describe, expect, test } from 'bun:test'
import { attachmentNote, nonTextBlocks, lastUserIndex } from '../src/agent.ts'
import type { MessageAttachment } from '../src/context.ts'
import type { ConversationMessage } from '../src/conversation.ts'

const u = (text: string): ConversationMessage => ({ role: 'user', text })
const a = (text: string): ConversationMessage => ({ role: 'assistant', text })

describe('lastUserIndex', () => {
  test('the ordinary case — the last element is a user message', () => {
    expect(lastUserIndex([u('hello'), a('answer'), u('again')])).toBe(2)
  })

  test('the user message is found even when the history ends with an assistant', () => {
    // Exactly the race condition: the cancelled answer was saved after the
    // user message
    const messages = [
      u('first request'),
      u('second request'),
      a('⚠︎ The answer did not arrive in full: the request was cancelled'),
    ]
    expect(lastUserIndex(messages)).toBe(1)
    expect(messages[lastUserIndex(messages)]!.text).toBe('second request')
  })

  test('it is found after several consecutive assistant messages too', () => {
    expect(lastUserIndex([u('request'), a('one'), a('two'), a('three')])).toBe(0)
  })

  test('only one user message', () => {
    expect(lastUserIndex([u('alone')])).toBe(0)
  })

  test('no user message at all — -1', () => {
    expect(lastUserIndex([a('assistant only')])).toBe(-1)
    expect(lastUserIndex([])).toBe(-1)
  })

  test('the LAST user message is picked, not the first', () => {
    const messages = [u('old'), a('answer'), u('new'), a('cancelled')]
    expect(messages[lastUserIndex(messages)]!.text).toBe('new')
  })
})

// An attached file reaches the agent through THE PROMPT TEXT — not as base64.
// An image is a file too: the agent reads it with `read` and sees it then.
describe('attachmentNote', () => {
  const image: MessageAttachment = {
    kind: 'image',
    originalName: 'screen.png',
    path: '.platforma/sessions/s1/files/screen.png',
  }
  const file: MessageAttachment = {
    kind: 'file',
    originalName: 'report.pdf',
    path: '.platforma/sessions/s1/files/report.pdf',
  }

  test('the text is left alone when there is no attachment', () => {
    expect(attachmentNote('hello')).toBe('hello')
    expect(attachmentNote('hello', [])).toBe('hello')
  })

  test('the path lands in the prompt', () => {
    const result = attachmentNote('what is this?', [image])

    expect(result).toContain('what is this?')
    expect(result).toContain(image.path)
  })

  test('an image gets a `read` instruction', () => {
    const result = attachmentNote('describe it', [image])

    expect(result).toContain('read')
    // The agent has to know it CAN SEE the image, otherwise it would take the
    // file for text and conclude "it could not be read"
    expect(result).toContain('image')
  })

  test('several files come out as a list', () => {
    const result = attachmentNote('take a look', [image, file])

    expect(result).toContain(image.path)
    expect(result).toContain(file.path)
  })

  test('the note is added even when the text is empty', () => {
    // The user may send only a file and write nothing
    const result = attachmentNote('', [file])

    expect(result).toContain(file.path)
  })

  // The file contents are NOT PUT into the prompt — the agent fetches them
  // itself with `read`. Otherwise a 10 MB log file would fill the context on
  // its own.
  test('the file contents are not put into the prompt — only the path', () => {
    const result = attachmentNote('check it', [file])

    expect(result.length).toBeLessThan(500)
  })
})

// `afterToolCall` rebuilds the result after the hooks. It used to replace
// `content` entirely with `[{type:'text'}]` and that SILENTLY DESTROYED THE
// IMAGE: when the `read` tool reads an image file it returns
// `[{type:'text'}, {type:'image'}]`, while the hooks (`lengthHook`,
// `redactSecretsHook`) run over nearly every result.
//
// An attached image comes in by EXACTLY that path, i.e. without this fix the
// "attach an image" feature would not work — with no error message.
describe('nonTextBlocks', () => {
  const imageResult = {
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  }

  test('the image block is kept', () => {
    const blocks = nonTextBlocks(imageResult)

    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { type: string }).type).toBe('image')
  })

  test('text blocks are not taken — they are rebuilt from the hook result', () => {
    const blocks = nonTextBlocks({
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    })

    expect(blocks).toEqual([])
  })

  test('several images are kept as well', () => {
    const blocks = nonTextBlocks({
      content: [
        { type: 'text', text: 'x' },
        { type: 'image', data: 'A', mimeType: 'image/png' },
        { type: 'image', data: 'B', mimeType: 'image/jpeg' },
      ],
    })

    expect(blocks).toHaveLength(2)
  })

  test('a malformed shape does not bring it down', () => {
    expect(nonTextBlocks(undefined)).toEqual([])
    expect(nonTextBlocks(null)).toEqual([])
    expect(nonTextBlocks('text')).toEqual([])
    expect(nonTextBlocks({})).toEqual([])
    expect(nonTextBlocks({ content: 'not an array' })).toEqual([])
    expect(nonTextBlocks({ content: [null, undefined] })).toEqual([])
  })

  // The filter picks "image" EXPLICITLY, not by negation as "not text".
  // The reason: if pi adds a new block kind in the future (`audio`, say), it
  // must not slip through to the provider unchecked.
  test('an unknown block kind is not let through', () => {
    const blocks = nonTextBlocks({
      content: [
        { type: 'text', text: 'x' },
        { type: 'future-kind', data: 'something' },
        { type: 'image', data: 'A', mimeType: 'image/png' },
      ],
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('image')
  })
})
