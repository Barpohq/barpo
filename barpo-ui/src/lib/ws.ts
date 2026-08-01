// WebSocket client — a single connection for listening to server events.
//
// The whole app uses one socket (it is not dropped when pages change). If the
// connection drops it reconnects automatically and restores subscriptions —
// the server does not remember them, so `sub` is re-sent on every new
// connection.
//
// Adding a new event type changes nothing here: `watch()` hands over the
// `ServerEvent` union from the protocol and the caller discriminates on
// `type`.

import type { ClientEvent, ServerEvent } from '@barpo/shared'

type Listener = (event: ServerEvent) => void

/** Reconnect delays (ms) — the last one repeats */
const DELAYS = [500, 1000, 2000, 5000, 10000]

class WsClient {
  private socket: WebSocket | null = null
  private listeners = new Set<Listener>()
  private channels = new Set<string>()
  /**
   * The chat session currently being watched.
   *
   * Sent to the server with `sub` — it then filters chat events by this
   * session so a conversation in another window does not leak in here. Kept
   * here so it can be restored on reconnect (the server does not remember
   * subscriptions).
   */
  private sessionId: string | undefined
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  connect(): void {
    if (this.socket || this.closed) return

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/ws`)
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      // Restore subscriptions — the server knows nothing about the old
      // connection's subscription. The session is re-sent too, otherwise the
      // new connection would stay unfiltered and pull in events from foreign
      // sessions.
      if (this.channels.size > 0) {
        this.send({ type: 'sub', channels: [...this.channels], sessionId: this.sessionId })
      }
    }

    socket.onmessage = (message) => {
      let event: ServerEvent
      try {
        event = JSON.parse(String(message.data)) as ServerEvent
      } catch {
        return // malformed JSON — ignore
      }
      for (const l of this.listeners) {
        try {
          l(event)
        } catch (error) {
          // One listener's error must not stop the rest
          console.error('[ws] listener error', error)
        }
      }
    }

    socket.onclose = () => {
      this.socket = null
      this.reconnect()
    }

    socket.onerror = () => {
      // onclose fires anyway — reconnecting happens there
      socket.close()
    }
  }

  private reconnect(): void {
    if (this.closed || this.timer) return
    const delay = DELAYS[Math.min(this.attempt, DELAYS.length - 1)]
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  /** Subscribes to channels. Returns an unsubscribe function. */
  subscribe(channels: string[]): () => void {
    const fresh = channels.filter((c) => !this.channels.has(c))
    for (const c of channels) this.channels.add(c)
    if (fresh.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: 'sub', channels: fresh, sessionId: this.sessionId })
    }
    return () => {
      for (const c of channels) this.channels.delete(c)
      // There is no unsubscribe event on the server — it is not restored on
      // the next connection
    }
  }

  /**
   * Tells the server which chat session is being watched.
   *
   * Called once the session exists (on the first message). After that the
   * server only sends this connection the chat events of that session.
   *
   * Passing `undefined` removes the filter — the client sees all sessions
   * again (for example after "new conversation" is clicked and the session
   * does not exist yet).
   */
  watchSession(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    // The channels are re-sent as well — the server `add`s them, so repeating
    // does no harm. `null` is sent to clear the session: `undefined` would
    // drop the field from the JSON entirely and the server would read that as
    // "leave unchanged".
    this.sendOrConnect({
      type: 'sub',
      channels: [...this.channels],
      sessionId: sessionId ?? null,
    })
  }

  /** Listens to server events. Returns an unsubscribe function. */
  watch(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  send(event: ClientEvent): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(event))
    return true
  }

  /**
   * A send that waits for `onopen` when the socket is not open yet.
   *
   * WHY IT IS NEEDED. `sub` is the one event type whose FAILURE TO ARRIVE
   * silently loses data: the server filters chat events by session, so if
   * `sub` never lands the client does not receive `chat.permission` AT ALL
   * and the agent keeps waiting for an answer. A plain `send()` would just
   * return `false` and drop it silently.
   *
   * The race is real: when the first message is sent the socket may still be
   * connecting or reconnecting. `onopen` restores subscriptions anyway, but
   * there is a gap until then.
   */
  private sendOrConnect(event: ClientEvent): void {
    if (this.send(event)) return
    this.connect()
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }
}

/** The single client for the whole app */
export const ws = new WsClient()
