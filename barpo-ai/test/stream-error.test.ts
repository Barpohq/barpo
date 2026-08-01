// Does a provider error make it out of the stream?
//
// This test guards one specific failure: pi-agent-core DOES NOT THROW a
// provider error out of `agent.prompt()` — it writes it onto the last
// `assistant` message as `stopReason: 'error'`. Without this check the stream
// counted as successful, the user saw an EMPTY answer and nothing was written
// to the database — the "the chat started and ended immediately" bug came from
// exactly this.
//
// Real examples (taken from a user's database):
//   OpenRouter → 400 "Reasoning is mandatory for this endpoint"
//   Codex      → "Encountered invalidated oauth token for user"

import { describe, expect, test } from 'bun:test'
import { streamError } from '../src/agent.ts'

describe('streamError', () => {
  test('no error on a successful stream', () => {
    expect(
      streamError([
        { role: 'user', content: [] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'hello' }] },
      ]),
    ).toBeUndefined()
  })

  test('a provider error comes back with its reason text', () => {
    const error = streamError([
      { role: 'user', content: [] },
      {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '400: Reasoning is mandatory for this endpoint',
        content: [],
      },
    ])
    expect(error).toBe('400: Reasoning is mandatory for this endpoint')
  })

  test('the error survives even without a reason text', () => {
    expect(streamError([{ role: 'assistant', stopReason: 'error', content: [] }])).toBe(
      'the provider could not return a response',
    )
    expect(
      streamError([{ role: 'assistant', stopReason: 'error', errorMessage: '   ', content: [] }]),
    ).toBe('the provider could not return a response')
  })

  test('only the LAST assistant message counts', () => {
    // In a tool chain an earlier turn may have failed while the next one
    // recovered — in that case an answer really did arrive, so we do not mark
    // it as an error.
    expect(
      streamError([
        { role: 'assistant', stopReason: 'error', errorMessage: 'temporary outage', content: [] },
        { role: 'toolResult', content: [] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
      ]),
    ).toBeUndefined()
  })

  test('cancelling (aborted) does not count as an error', () => {
    // The caller knows about the cancellation itself (`signal.aborted`) and
    // reports it with its own message — it must not be duplicated here.
    expect(streamError([{ role: 'assistant', stopReason: 'aborted', content: [] }])).toBeUndefined()
  })

  test('no error when there is no assistant message at all', () => {
    expect(streamError([])).toBeUndefined()
    expect(streamError([{ role: 'user', content: [] }])).toBeUndefined()
  })
})
