// WebSocket hub — the registry of connected clients and event fan-out.
//
// A `ConnectionState` is kept for every connection: the set of channels it has
// subscribed to. Until the client sends `sub` it is subscribed to nothing, i.e.
// it only receives channel-less events (`hello`). This is deliberate: the UI
// asks for exactly the channels it needs and no surplus traffic is sent.
//
// This module is independent of the HTTP layer — the `Bun.serve` websocket
// handlers call the functions here (wired up in src/index.ts).

import type { ServerWebSocket } from 'bun'
import {
  isClientEvent,
  eventChannel,
  eventSession,
  PROTOCOL_VERSION,
  type ClientEvent,
  type ServerEvent,
} from '@platforma/shared'

/** The data attached to every WS connection */
export interface ConnectionState {
  id: string
  channels: Set<string>
  /**
   * The chat session the client is watching (`sub.sessionId`).
   *
   * `undefined` — no session given: the client receives the events of EVERY
   * session on the channel (the old behaviour, kept for backwards
   * compatibility).
   */
  sessionId?: string
}

export type PlatformWS = ServerWebSocket<ConnectionState>

/** Handles an event coming from a client — the orchestrator hooks in here */
export type ClientEventHandler = (event: ClientEvent, ws: PlatformWS) => void

export class WsHub {
  private connections = new Set<PlatformWS>()
  private handlers: ClientEventHandler[] = []

  /** The number of clients connected right now */
  get count(): number {
    return this.connections.size
  }

  /**
   * A new connection was opened: it is added to the registry and sent `hello`.
   */
  connected(ws: PlatformWS): void {
    this.connections.add(ws)
    this.send(ws, { type: 'hello', version: PROTOCOL_VERSION })
  }

  /** The connection was closed */
  disconnected(ws: PlatformWS): void {
    this.connections.delete(ws)
  }

  /**
   * A raw message from a client. `sub` is handled here, every other event is
   * passed on to the registered handlers.
   */
  messageReceived(ws: PlatformWS, raw: string): void {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return // malformed JSON — dropped silently
    }

    if (!isClientEvent(value)) return
    const event = value

    if (event.type === 'sub') {
      for (const channel of event.channels) ws.data.channels.add(channel)
      // If a session is given the client "moves" to that session.
      //   `null`        → the filter is removed (every session is visible again);
      //   field absent  → the previous choice is kept (the client may only be
      //                   adding a channel and should not lose its session).
      if (event.sessionId !== undefined) {
        ws.data.sessionId = event.sessionId ?? undefined
      }
      return
    }

    for (const h of this.handlers) h(event, ws)
  }

  /**
   * Registers a handler for client events (this is how the orchestrator
   * receives `chat.send` and `chat.choice`). Returns a function that
   * unregisters it.
   */
  addHandler(h: ClientEventHandler): () => void {
    this.handlers.push(h)
    return () => {
      const i = this.handlers.indexOf(h)
      if (i >= 0) this.handlers.splice(i, 1)
    }
  }

  /**
   * Sends the event to every client subscribed to the relevant channel.
   * Channel-less events (hello) go to everyone.
   * Returns the number of clients it was sent to.
   *
   * TWO-STAGE FILTER:
   *   1) channel — if the client is not subscribed to the channel the event
   *      does not go out;
   *   2) session — a session-bound event (chat.*) only reaches the client that
   *      is watching that session.
   *
   * Why the second filter is needed: only the channel used to be checked, so
   * ANY client subscribed to the `chat` channel received the responses of every
   * session. With two browser windows open, one would see the other's
   * `chat.delta` (the response text), `chat.tool` (the commands that ran) and
   * `chat.permission` (permission requests) events. That is both a UI fault
   * (someone else's text flows into the wrong window) and an information leak.
   *
   * A client that did not name a session gets the old behaviour — it sees
   * every session.
   */
  broadcast(event: ServerEvent): number {
    const channel = eventChannel(event)
    const session = eventSession(event)
    const text = JSON.stringify(event)
    let count = 0

    for (const ws of this.connections) {
      if (channel !== null && !ws.data.channels.has(channel)) continue
      // Session-bound event: skipped if the client is watching another session.
      // `ws.data.sessionId === undefined` — the client picked no session and
      // receives everything.
      if (
        session !== null &&
        ws.data.sessionId !== undefined &&
        ws.data.sessionId !== session
      ) {
        continue
      }
      try {
        ws.send(text)
        count++
      } catch {
        // a socket that has already closed — removed from the registry
        this.connections.delete(ws)
      }
    }
    return count
  }

  /** Sending to a single client (the channel filter is not applied) */
  send(ws: PlatformWS, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event))
    } catch {
      this.connections.delete(ws)
    }
  }

  /** For tests: clear every connection */
  clear(): void {
    this.connections.clear()
    this.handlers = []
  }
}

/** The single hub for the whole process */
export const hub = new WsHub()

let _idCounter = 0

/** The state object for a new connection */
export function newConnectionState(): ConnectionState {
  _idCounter += 1
  return { id: `ws-${_idCounter}`, channels: new Set<string>() }
}
