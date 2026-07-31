// Protocol guards — the channel and session filter of the `chat.status` event.
//
// These tests are DELIBERATELY strict: the fact that `chat.status` is not
// filtered by session is a design decision, not an accident. If somebody
// "fixes" it by adding the event to `eventSession()`, the sidebar stops seeing
// the status of other sessions and the breakage is silent — no type error at
// all.

import { describe, expect, test } from 'bun:test'
import {
  CHANNELS,
  eventChannel,
  eventSession,
  type StreamStatus,
  type ServerEvent,
} from '@platforma/shared'

function status(sessionId: string, streamStatus: StreamStatus): ServerEvent {
  return { type: 'chat.status', sessionId, status: streamStatus }
}

describe('chat.status — channel', () => {
  test('it belongs to the chat channel', () => {
    expect(eventChannel(status('s1', 'running'))).toBe(CHANNELS.chat)
  })

  test('it shares a channel with the other chat events', () => {
    const delta: ServerEvent = { type: 'chat.delta', sessionId: 's1', messageId: 'm', delta: 'x' }
    expect(eventChannel(status('s1', 'done'))).toBe(eventChannel(delta))
  })
})

describe('chat.status — session filter', () => {
  test('it returns no session, so it is never filtered out', () => {
    // DESIGN DECISION: the event carries a `sessionId`, but not for filtering —
    // the sidebar has to see the status of every session.
    expect(eventSession(status('s1', 'running'))).toBeNull()
  })

  test('no status value is filtered', () => {
    const statuses: StreamStatus[] = ['running', 'awaiting-permission', 'done', 'error']
    for (const s of statuses) {
      expect(eventSession(status('s1', s))).toBeNull()
    }
  })

  test('the chat events that carry content are still filtered', () => {
    // We check that the boundary held: the exception made for status must not
    // spread to the rest — the reply text and the permission request are still
    // bound to their session.
    expect(eventSession({ type: 'chat.delta', sessionId: 's1', messageId: 'm', delta: 'x' })).toBe(
      's1',
    )
    expect(eventSession({ type: 'chat.done', sessionId: 's1', messageId: 'm' })).toBe('s1')
    expect(
      eventSession({ type: 'chat.error', sessionId: 's1', messageId: 'm', error: 'e' }),
    ).toBe('s1')
  })
})
