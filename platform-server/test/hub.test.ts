// WS hub tests — subscriptions, the broadcast filter and client event handling.

import { describe, expect, test } from 'bun:test'
import type { ClientEvent, ServerEvent } from '@platforma/shared'
import { WsHub, type PlatformWS } from '../src/ws/hub.ts'

/** A fake WS connection — collects the events it is sent into an array */
function fakeWs(channels: string[] = [], sessionId?: string) {
  const received: ServerEvent[] = []
  const ws = {
    data: { id: `fake-${Math.random()}`, channels: new Set(channels), sessionId },
    send: (m: string) => received.push(JSON.parse(m) as ServerEvent),
  }
  return { ws: ws as unknown as PlatformWS, received }
}

/** A chat event — shorthand for the session filter tests */
function chatDelta(sessionId: string, delta = 'x'): ServerEvent {
  return { type: 'chat.delta', sessionId, messageId: 'm1', delta }
}

describe('WsHub', () => {
  test('hello is sent on connect', () => {
    const hub = new WsHub()
    const { ws, received } = fakeWs()
    hub.connected(ws)

    expect(hub.count).toBe(1)
    expect(received[0]?.type).toBe('hello')
  })

  test('a closed connection leaves the registry', () => {
    const hub = new WsHub()
    const { ws } = fakeWs()
    hub.connected(ws)
    hub.disconnected(ws)
    expect(hub.count).toBe(0)
  })

  test('a broadcast only reaches subscribers', () => {
    const hub = new WsHub()
    const subscriber = fakeWs(['audit'])
    const outsider = fakeWs(['chat'])
    hub.connected(subscriber.ws)
    hub.connected(outsider.ws)
    subscriber.received.length = 0
    outsider.received.length = 0

    const count = hub.broadcast({
      type: 'audit.entry',
      entry: { time: '10:00', actor: 'test', action: 'a', target: 't', level: 'read', result: 'OK' },
    })

    expect(count).toBe(1)
    expect(subscriber.received).toHaveLength(1)
    expect(outsider.received).toHaveLength(0)
  })

  test('a sub event adds the subscription and the next broadcast arrives', () => {
    const hub = new WsHub()
    const { ws, received } = fakeWs()
    hub.connected(ws)
    received.length = 0

    // without a subscription — no event arrives
    hub.broadcast({ type: 'build.done', buildId: 'b1', appId: 'app1' })
    expect(received).toHaveLength(0)

    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['build'] }))
    hub.broadcast({ type: 'build.done', buildId: 'b1', appId: 'app1' })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'build.done', buildId: 'b1' })
  })

  test('client events are passed on to the handler', () => {
    const hub = new WsHub()
    const { ws } = fakeWs()
    hub.connected(ws)

    const received: ClientEvent[] = []
    hub.addHandler((e) => received.push(e))

    hub.messageReceived(ws, JSON.stringify({ type: 'chat.send', sessionId: 's1', text: 'hello' }))

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'chat.send', sessionId: 's1', text: 'hello' })
  })

  test('malformed JSON and an unknown event type are ignored', () => {
    const hub = new WsHub()
    const { ws } = fakeWs()
    hub.connected(ws)

    const received: ClientEvent[] = []
    hub.addHandler((e) => received.push(e))

    expect(() => hub.messageReceived(ws, '{malformed json')).not.toThrow()
    hub.messageReceived(ws, JSON.stringify({ type: 'unknown.event' }))

    expect(received).toHaveLength(0)
  })

  test('the function addHandler returns unregisters the handler', () => {
    const hub = new WsHub()
    const { ws } = fakeWs()
    hub.connected(ws)

    const received: ClientEvent[] = []
    const unregister = hub.addHandler((e) => received.push(e))

    hub.messageReceived(ws, JSON.stringify({ type: 'chat.send', sessionId: 's1', text: 'one' }))
    unregister()
    hub.messageReceived(ws, JSON.stringify({ type: 'chat.send', sessionId: 's1', text: 'two' }))

    expect(received).toHaveLength(1)
  })
})

describe('session isolation', () => {
  test('a chat event only reaches the client watching that session', () => {
    // THE ORIGINAL BUG: both windows used to receive each other's replies
    const hub = new WsHub()
    const first = fakeWs(['chat'], 's1')
    const second = fakeWs(['chat'], 's2')
    hub.connected(first.ws)
    hub.connected(second.ws)
    first.received.length = 0
    second.received.length = 0

    const count = hub.broadcast(chatDelta('s1', 'hello'))

    expect(count).toBe(1)
    expect(first.received).toHaveLength(1)
    expect(second.received).toHaveLength(0)
  })

  test('a permission request does not leak into another session', () => {
    // chat.permission is the most delicate one: the confirmation button used to
    // pop up in the other window
    const hub = new WsHub()
    const owner = fakeWs(['chat'], 's1')
    const outsider = fakeWs(['chat'], 's2')
    hub.connected(owner.ws)
    hub.connected(outsider.ws)
    owner.received.length = 0
    outsider.received.length = 0

    hub.broadcast({
      type: 'chat.permission',
      sessionId: 's1',
      messageId: 'm1',
      request: {
        id: 'r1',
        sessionId: 's1',
        kind: 'command',
        action: 'bash',
        target: 'rm -rf x',
        reason: 'test',
        pattern: 'rm',
        time: '2026-01-01T00:00:00.000Z',
      },
    })

    expect(owner.received).toHaveLength(1)
    expect(outsider.received).toHaveLength(0)
  })

  test('tool and error events are filtered as well', () => {
    const hub = new WsHub()
    const owner = fakeWs(['chat'], 's1')
    const outsider = fakeWs(['chat'], 's2')
    hub.connected(owner.ws)
    hub.connected(outsider.ws)
    outsider.received.length = 0

    hub.broadcast({
      type: 'chat.tool',
      sessionId: 's1',
      messageId: 'm1',
      tool: { id: 't1', name: 'bash', args: 'ls', status: 'done' },
    })
    hub.broadcast({ type: 'chat.error', sessionId: 's1', messageId: 'm1', error: 'error' })
    hub.broadcast({ type: 'chat.done', sessionId: 's1', messageId: 'm1' })

    expect(outsider.received).toHaveLength(0)
  })

  test('a client that named no session receives everything (backwards compatibility)', () => {
    const hub = new WsHub()
    const old = fakeWs(['chat']) // no sessionId — an older client
    hub.connected(old.ws)
    old.received.length = 0

    hub.broadcast(chatDelta('s1'))
    hub.broadcast(chatDelta('s2'))

    expect(old.received).toHaveLength(2)
  })

  test('events that are not tied to a session are not filtered', () => {
    // audit/build/app events belong to no session — everyone should get them
    const hub = new WsHub()
    const client = fakeWs(['audit', 'build'], 's1')
    hub.connected(client.ws)
    client.received.length = 0

    hub.broadcast({
      type: 'audit.entry',
      entry: { time: '10:00', actor: 't', action: 'a', target: 't', level: 'read', result: 'OK' },
    })
    hub.broadcast({ type: 'build.done', buildId: 'b1', appId: 'app1' })

    expect(client.received).toHaveLength(2)
  })

  test('a sub event sets the session', () => {
    const hub = new WsHub()
    const { ws, received } = fakeWs()
    hub.connected(ws)
    received.length = 0

    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))

    hub.broadcast(chatDelta('s1'))
    hub.broadcast(chatDelta('s2'))

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ sessionId: 's1' })
  })

  test('a sub without a session does not disturb the earlier choice', () => {
    // On a later `sub` the client may only be adding a new channel
    const hub = new WsHub()
    const { ws, received } = fakeWs()
    hub.connected(ws)

    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))
    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['audit'] }))
    received.length = 0

    hub.broadcast(chatDelta('s2'))
    expect(received).toHaveLength(0) // the session is still s1

    hub.broadcast(chatDelta('s1'))
    expect(received).toHaveLength(1)
  })

  test('sessionId: null removes the filter', () => {
    const hub = new WsHub()
    const { ws, received } = fakeWs()
    hub.connected(ws)

    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))
    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: null }))
    received.length = 0

    hub.broadcast(chatDelta('s1'))
    hub.broadcast(chatDelta('s2'))

    expect(received).toHaveLength(2)
  })

  test('chat.status reaches other sessions too (deliberately)', () => {
    // For the sidebar badges: a client that has s1 open MUST be able to see
    // that an agent is running in s2. This is unlike the rest of the chat.*
    // events.
    const hub = new WsHub()
    const first = fakeWs(['chat'], 's1')
    const second = fakeWs(['chat'], 's2')
    hub.connected(first.ws)
    hub.connected(second.ws)
    first.received.length = 0
    second.received.length = 0

    const count = hub.broadcast({ type: 'chat.status', sessionId: 's2', status: 'running' })

    expect(count).toBe(2)
    expect(first.received).toHaveLength(1)
    expect(first.received[0]).toMatchObject({ sessionId: 's2', status: 'running' })
    expect(second.received).toHaveLength(1)
  })

  test('chat.status does still pass through the channel filter', () => {
    // The lack of filtering applies to the SESSION only — a client that is not
    // subscribed to the chat channel (one watching audit alone, say) must not
    // receive it.
    const hub = new WsHub()
    const withoutChat = fakeWs(['audit'])
    hub.connected(withoutChat.ws)
    withoutChat.received.length = 0

    const count = hub.broadcast({ type: 'chat.status', sessionId: 's1', status: 'running' })

    expect(count).toBe(0)
    expect(withoutChat.received).toHaveLength(0)
  })

  test('switching sessions moves the watch to the new one', () => {
    // "+ new conversation" → moving to a different session
    const hub = new WsHub()
    const { ws, received } = fakeWs()
    hub.connected(ws)

    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))
    hub.messageReceived(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's2' }))
    received.length = 0

    hub.broadcast(chatDelta('s1'))
    expect(received).toHaveLength(0)

    hub.broadcast(chatDelta('s2'))
    expect(received).toHaveLength(1)
  })
})
