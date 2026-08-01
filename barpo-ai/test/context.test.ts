// Context layer tests.
//
// Two mandatory behaviours are checked:
//   1) tool results are kept in the history (without that the agent loses its
//      memory every turn — this was the main functional defect);
//   2) the cut NEVER starts at a `toolResult` — otherwise the provider gets a
//      context with "an answer but no question" and rejects the request. That
//      is a failure that breaks silently, so a test enforces it.
//
// The LLM call (`compact`) is not tested here — it goes to the network. What
// is tested is the pure logic: the decision, the cut point, the truncation.

import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core/node'
import {
  dropOldest,
  cutPoint,
  buildContext,
  contextTokens,
  needsCompaction,
  truncateToolResults,
} from '../src/context.ts'

// --- Helper builders ---

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1,
  } as AgentMessage
}

function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'tc-1',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage
}

describe('building the context', () => {
  test('a message with agentMessages passes through raw (tool results are kept)', () => {
    // This is the main fix: tool results used to be lost
    const stored = [
      { role: 'user' as const, text: 'read the file' },
      {
        role: 'assistant' as const,
        text: 'I read it',
        agentMessages: [assistant('reading'), toolResult('FILE CONTENTS'), assistant('I read it')],
      },
    ]
    const context = buildContext(stored)
    const texts = JSON.stringify(context)
    expect(texts).toContain('FILE CONTENTS')
    expect(context).toHaveLength(4) // 1 user + 3 agent messages
  })

  test('without agentMessages it is built from text (older messages)', () => {
    const context = buildContext([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hello!' },
    ])
    expect(context).toHaveLength(2)
    expect(context[0]!.role).toBe('user')
    expect(context[1]!.role).toBe('assistant')
  })

  test('old and new messages can be mixed', () => {
    // That is what happens when a pre-migration conversation is continued
    const context = buildContext([
      { role: 'user', text: 'old question' },
      { role: 'assistant', text: 'old answer' },
      { role: 'user', text: 'new question' },
      { role: 'assistant', text: 'new answer', agentMessages: [assistant('new answer')] },
    ])
    expect(context).toHaveLength(4)
  })

  test('a message with empty text is dropped (some providers reject it)', () => {
    const context = buildContext([
      { role: 'user', text: '   ' },
      { role: 'user', text: 'real' },
    ])
    expect(context).toHaveLength(1)
  })

  test('an empty list gives an empty context', () => {
    expect(buildContext([])).toEqual([])
  })
})

describe('truncating tool results', () => {
  test('a result longer than the limit is cut and this is ANNOUNCED', () => {
    const long = 'x'.repeat(5000)
    const result = truncateToolResults([toolResult(long)], 1000)
    const text = (result[0] as unknown as { content: { text: string }[] }).content[0]!.text
    expect(text.length).toBeLessThan(2000)
    // The agent must know the result is incomplete
    expect(text).toContain('truncated')
  })

  test('a result shorter than the limit is left alone', () => {
    const input = [toolResult('short')]
    const result = truncateToolResults(input, 1000)
    expect(result[0]).toBe(input[0]!)
  })

  test('messages that are not toolResult are left alone', () => {
    const input = [user('a'.repeat(5000)), assistant('b'.repeat(5000))]
    const result = truncateToolResults(input, 100)
    expect(result[0]).toBe(input[0]!)
    expect(result[1]).toBe(input[1]!)
  })
})

describe('the compaction decision', () => {
  const options = { enabled: true, reserveTokens: 1000, keptTokens: 500 }

  test('never compacts when disabled', () => {
    const large = Array.from({ length: 500 }, () => user('x'.repeat(1000)))
    expect(needsCompaction(large, 8000, { ...options, enabled: false })).toBe(false)
  })

  test('a small context is not compacted', () => {
    expect(needsCompaction([user('hello')], 100_000, options)).toBe(false)
  })

  test('a large context is compacted', () => {
    const large = Array.from({ length: 200 }, () => user('x'.repeat(500)))
    expect(needsCompaction(large, 8000, options)).toBe(true)
  })

  test('no compaction when contextWindow is unknown (0)', () => {
    // Not compacting is safer than compacting on a guess: a wrong compaction
    // loses context, while not compacting only produces an error
    const large = Array.from({ length: 200 }, () => user('x'.repeat(500)))
    expect(needsCompaction(large, 0, options)).toBe(false)
  })

  test('no compaction when the reserve is larger than contextWindow', () => {
    expect(needsCompaction([user('a')], 500, { ...options, reserveTokens: 1000 })).toBe(false)
  })
})

describe('the cut point', () => {
  test('recent messages are kept', () => {
    const messages = Array.from({ length: 100 }, (_, i) => user(`message ${i} ${'x'.repeat(400)}`))
    const point = cutPoint(messages, 1000)
    expect(point).toBeGreaterThan(0)
    expect(point).toBeLessThan(messages.length)
  })

  test('THE CUT DOES NOT START AT A toolResult', () => {
    // The most important rule: a toolResult has to stay together with the
    // assistant message that invoked it, otherwise the provider rejects the
    // request
    const messages: AgentMessage[] = []
    for (let i = 0; i < 50; i += 1) {
      messages.push(assistant(`call ${i}`))
      messages.push(toolResult(`result ${i} ${'x'.repeat(300)}`))
    }
    for (const kept of [200, 500, 1000, 2000, 5000]) {
      const point = cutPoint(messages, kept)
      expect(messages[point]?.role, `kept=${kept}`).not.toBe('toolResult')
    }
  })

  test('returns 0 when everything fits', () => {
    expect(cutPoint([user('small')], 1_000_000)).toBe(0)
  })

  test('0 on an empty list', () => {
    expect(cutPoint([], 1000)).toBe(0)
  })
})

describe('dropping the oldest (the fallback path)', () => {
  test('the oldest are dropped when there are more than the limit', () => {
    const messages = Array.from({ length: 100 }, (_, i) => user(`x${i}`))
    const result = dropOldest(messages, 10)
    expect(result.length).toBeLessThanOrEqual(10)
    // The newest ones stay
    expect(JSON.stringify(result.at(-1))).toContain('x99')
  })

  test('left alone when there are fewer than the limit', () => {
    const messages = [user('a'), user('b')]
    expect(dropOldest(messages, 10)).toBe(messages)
  })

  test('the result does not start at a toolResult', () => {
    const messages: AgentMessage[] = []
    for (let i = 0; i < 50; i += 1) {
      messages.push(assistant(`c${i}`))
      messages.push(toolResult(`r${i}`))
    }
    for (const max of [5, 10, 11, 20, 21]) {
      const result = dropOldest(messages, max)
      expect(result[0]?.role, `max=${max}`).not.toBe('toolResult')
    }
  })
})

describe('the token count', () => {
  test('an empty context is 0 tokens', () => {
    expect(contextTokens([])).toBe(0)
  })

  test('a larger context has more tokens', () => {
    const small = [user('hello')]
    const large = Array.from({ length: 100 }, () => user('x'.repeat(1000)))
    expect(contextTokens(large)).toBeGreaterThan(contextTokens(small))
  })
})

// An image enters the context through the `read` tool (when an attached image
// file is read). Its token size must NOT be counted by the LENGTH of the
// base64 — otherwise a 5 MB image comes out as ~1.7 million "tokens" and the
// compaction logic breaks entirely.
describe('a context with an image', () => {
  /** ~1 MB of base64 — the order of magnitude of a real image */
  const LARGE_BASE64 = 'A'.repeat(1_000_000)

  function imageResult(base64: string): AgentMessage {
    return {
      role: 'toolResult',
      toolCallId: 'tc-image',
      toolName: 'read',
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: base64, mimeType: 'image/png' },
      ],
      isError: false,
      timestamp: 1,
    } as unknown as AgentMessage
  }

  test('an image is not counted by the length of its base64', () => {
    const tokens = contextTokens([imageResult(LARGE_BASE64)])

    // With `JSON.stringify(...).length / 4` this would come out as ~250,000.
    // pi counts an image as a fixed ~1200 tokens.
    expect(tokens).toBeLessThan(5000)
  })

  test('doubling the image size does not increase the token count', () => {
    const one = contextTokens([imageResult(LARGE_BASE64)])
    const two = contextTokens([imageResult(LARGE_BASE64.repeat(2))])

    expect(two).toBe(one)
  })

  // THE MOST IMPORTANT REGRESSION: if `cutPoint` could not fit even a single
  // image message into `keptTokens`, compaction would send THE ENTIRE RECENT
  // HISTORY off to be summarised and the agent would lose its current work.
  test('a message with an image does not break the cut point', () => {
    const messages = [
      user('old request'),
      assistant('old answer'),
      user('what is in this image?'),
      assistant('reading it'),
      imageResult(LARGE_BASE64),
    ]

    const point = cutPoint(messages, 20_000)

    // The recent history has to be kept — it must not all be cut away
    expect(point).toBeLessThan(messages.length)
    expect(point).toBe(0)
  })

  test('an image does not trigger the compaction decision by itself', () => {
    const options = { enabled: true, reserveTokens: 16_384, keptTokens: 20_000 }

    // A 200k context window — a single image must not fill it
    expect(needsCompaction([imageResult(LARGE_BASE64)], 200_000, options)).toBe(false)
  })
})
