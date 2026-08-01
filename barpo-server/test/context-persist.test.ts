// Tool results surviving across a conversation — an end-to-end test.
//
// THE PROBLEM (now fixed): the history consisted of `{role, text}` pairs, so
// tool results never went back to the LLM. The agent lost its memory every turn:
//
//   message 1: "read package.json"  → the agent reads it and replies
//   message 2: "tell me the version" → the agent is forced to read the file AGAIN
//
// These tests run without an LLM: the write → read → build-context chain is
// what is exercised. An LLM call is not needed here, because the chain itself
// was the part that was broken.

import { beforeEach, describe, expect, test } from 'bun:test'
import { buildContext } from '@barpo/ai'
import { openDb, setDb } from '../src/db.ts'
import { createSession, readMessages, writeMessage } from '../src/repo.ts'

beforeEach(() => {
  setDb(openDb(':memory:'))
})

/** The `agentMessages` shape of an assistant message that carries a tool result */
function replyWithTool(file: string, contents: string) {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: file } }],
      api: 'openai-completions',
      provider: 'p',
      model: 'm',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 1,
    },
    {
      role: 'toolResult',
      toolCallId: 'tc-1',
      toolName: 'read',
      content: [{ type: 'text', text: contents }],
      isError: false,
      timestamp: 2,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Read it.' }],
      api: 'openai-completions',
      provider: 'p',
      model: 'm',
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 3,
    },
  ]
}

describe('tool results are stored in the database', () => {
  test('agentMessages is written and read back', () => {
    const s = createSession('test')
    writeMessage({ sessionId: s.id, role: 'user', text: 'read package.json' })
    writeMessage({
      sessionId: s.id,
      role: 'assistant',
      text: 'Read it.',
      agentMessages: replyWithTool('package.json', '{"version": "1.2.3"}'),
      contextTokens: 25,
    })

    const messages = readMessages(s.id)
    expect(messages).toHaveLength(2)

    const reply = messages[1]!
    expect(reply.agentMessages).toHaveLength(3)
    expect(reply.contextTokens).toBe(25)
    // The tool result — the whole point
    expect(JSON.stringify(reply.agentMessages)).toContain('1.2.3')
  })

  test('THE NEXT TURN can see the tool result', () => {
    // This is the end-to-end confirmation of the main fix
    const s = createSession('test')
    writeMessage({ sessionId: s.id, role: 'user', text: 'read package.json' })
    writeMessage({
      sessionId: s.id,
      role: 'assistant',
      text: 'Read it.',
      agentMessages: replyWithTool('package.json', '{"version": "1.2.3"}'),
    })
    writeMessage({ sessionId: s.id, role: 'user', text: 'tell me the version' })

    // This is the shape the orchestrator builds its history in
    const history = readMessages(s.id).map((m) => ({
      role: m.role,
      text: m.text,
      agentMessages: m.agentMessages,
    }))
    const context = buildContext(history)

    // The file contents MUST be in the context — otherwise the agent is forced
    // to read the file again
    expect(JSON.stringify(context)).toContain('1.2.3')
  })

  test('older messages (with no agentMessages) are not broken', () => {
    // Conversations from before migration 004 have to keep working
    const s = createSession('old')
    writeMessage({ sessionId: s.id, role: 'user', text: 'hello' })
    writeMessage({ sessionId: s.id, role: 'assistant', text: 'hello!' })

    const messages = readMessages(s.id)
    expect(messages[0]!.agentMessages).toBeUndefined()
    expect(messages[1]!.agentMessages).toBeUndefined()

    const context = buildContext(
      messages.map((m) => ({ role: m.role, text: m.text, agentMessages: m.agentMessages })),
    )
    expect(context).toHaveLength(2)
  })

  test('old and new messages work when mixed', () => {
    // This is what a conversation from before the migration looks like once it
    // is carried on
    const s = createSession('mixed')
    writeMessage({ sessionId: s.id, role: 'user', text: 'old question' })
    writeMessage({ sessionId: s.id, role: 'assistant', text: 'old answer' })
    writeMessage({ sessionId: s.id, role: 'user', text: 'new question' })
    writeMessage({
      sessionId: s.id,
      role: 'assistant',
      text: 'new answer',
      agentMessages: replyWithTool('a.txt', 'NEW CONTENTS'),
    })

    const context = buildContext(
      readMessages(s.id).map((m) => ({
        role: m.role,
        text: m.text,
        agentMessages: m.agentMessages,
      })),
    )
    const text = JSON.stringify(context)
    expect(text).toContain('old question')
    expect(text).toContain('NEW CONTENTS')
  })
})

describe('corrupt data does not kill the session', () => {
  test('corrupt agent_messages JSON does not stop the read', () => {
    const s = createSession('corrupt')
    const written = writeMessage({ sessionId: s.id, role: 'assistant', text: 'reply' })

    // We write corrupt JSON into the database by hand (a half-finished write,
    // for instance)
    const db = openDb(':memory:')
    setDb(db)
    const s2 = createSession('corrupt2')
    writeMessage({ sessionId: s2.id, role: 'assistant', text: 'reply' })
    db.prepare('UPDATE chat_messages SET agent_messages = ? WHERE session_id = ?').run(
      '{corrupt json,,,',
      s2.id,
    )

    // The read must not throw — the context is lost, the conversation survives
    const messages = readMessages(s2.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.agentMessages).toBeUndefined()
    expect(messages[0]!.text).toBe('reply')
    expect(written.id).toBeTruthy()
  })

  test('agent_messages that is not an array is ignored', () => {
    const db = openDb(':memory:')
    setDb(db)
    const s = createSession('object')
    writeMessage({ sessionId: s.id, role: 'assistant', text: 'reply' })
    db.prepare('UPDATE chat_messages SET agent_messages = ? WHERE session_id = ?').run(
      '{"array": "not"}',
      s.id,
    )
    expect(readMessages(s.id)[0]!.agentMessages).toBeUndefined()
  })
})
