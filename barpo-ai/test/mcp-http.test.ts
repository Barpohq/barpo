// The MCP HTTP transport — through a real server run with `Bun.serve`.
//
// Both variants are checked: `streamable-http` (an ordinary JSON response) and
// `sse` (`text/event-stream`). They are handled by one transport class — the
// only difference is the response format, so both have to be exercised.

import { afterEach, describe, expect, test } from 'bun:test'
import { McpClient } from '../src/mcp-client.ts'
import { createHttpTransport, parseSseMessages } from '../src/mcp-transport.ts'

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

interface FakeConfig {
  /** Answer in the SSE format */
  sse?: boolean
  /** Return an `Mcp-Session-Id` header */
  session?: string
  /** Return an HTTP error for these methods */
  errorMethods?: string[]
  /** Corrupt the response body */
  garbage?: boolean
}

interface Trace {
  methods: string[]
  sessionHeaders: (string | null)[]
  headers: Record<string, string>[]
}

/** Brings up a fake MCP HTTP server, returns the url and the trace */
function startServer(config: FakeConfig = {}): { url: string; trace: Trace } {
  const trace: Trace = { methods: [], sessionHeaders: [], headers: [] }

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const message = (await req.json()) as { id?: number; method?: string; params?: unknown }
      trace.methods.push(message.method ?? '')
      trace.sessionHeaders.push(req.headers.get('Mcp-Session-Id'))
      trace.headers.push(Object.fromEntries(req.headers.entries()))

      const headers: Record<string, string> = {}
      if (config.session) headers['Mcp-Session-Id'] = config.session

      if (config.errorMethods?.includes(message.method ?? '')) {
        return new Response('the server refused', { status: 400, headers })
      }

      // A notification — no response body
      if (message.id === undefined) {
        return new Response(null, { status: 202, headers })
      }

      if (config.garbage) {
        return new Response('this is not JSON', {
          status: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
        })
      }

      const answer = buildAnswer(message)

      if (config.sse) {
        return new Response(`event: message\ndata: ${JSON.stringify(answer)}\n\n`, {
          status: 200,
          headers: { ...headers, 'Content-Type': 'text/event-stream' },
        })
      }

      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      })
    },
  })

  return { url: `http://localhost:${server.port}/mcp`, trace }
}

function buildAnswer(message: { id?: number; method?: string; params?: unknown }): unknown {
  const { id, method } = message
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'remote-fake', version: '2.0' },
      },
    }
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{ name: 'search', description: 'Remote search', inputSchema: { type: 'object' } }],
      },
    }
  }
  if (method === 'tools/call') {
    const p = message.params as { name?: string; arguments?: { word?: string } }
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `found: ${p?.arguments?.word ?? ''}` }] },
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } }
}

function createClient(url: string, headers: Record<string, string> = {}): McpClient {
  return new McpClient({
    transport: 'http',
    url,
    headers,
    handshakeTimeoutMs: 5000,
    callTimeoutMs: 5000,
  })
}

// ---------------------------------------------------------------------------

describe('streamable-http (plain JSON)', () => {
  test('the whole flow works', async () => {
    const { url } = startServer()
    const client = createClient(url)

    await client.connect()
    expect(client.info?.serverInfo?.name).toBe('remote-fake')

    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['search'])

    const result = await client.call('search', { word: 'mcp' })
    expect(result.content[0]?.text).toBe('found: mcp')

    await client.disconnect()
  }, 15_000)

  test('a notification is sent after initialize', async () => {
    const { url, trace } = startServer()
    const client = createClient(url)
    await client.connect()

    expect(trace.methods).toEqual(['initialize', 'notifications/initialized'])
    await client.disconnect()
  }, 15_000)

  test('the headers (credentials) are added to every request', async () => {
    const { url, trace } = startServer()
    const client = createClient(url, { Authorization: 'Bearer secret-token' })

    await client.connect()
    await client.call('search', {})

    for (const h of trace.headers) {
      expect(h.authorization).toBe('Bearer secret-token')
    }
    await client.disconnect()
  }, 15_000)
})

describe('sse (text/event-stream)', () => {
  test('the whole flow works', async () => {
    const { url } = startServer({ sse: true })
    const client = createClient(url)

    await client.connect()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['search'])

    const result = await client.call('search', { word: 'sse' })
    expect(result.content[0]?.text).toBe('found: sse')

    await client.disconnect()
  }, 15_000)
})

describe('Mcp-Session-Id', () => {
  test('the session id the server gave is added to the following requests', async () => {
    const { url, trace } = startServer({ session: 'session-abc' })
    const client = createClient(url)

    await client.connect()
    await client.call('search', {})

    // On the first request there is no session yet, on the later ones there
    // must be one
    expect(trace.sessionHeaders[0]).toBeNull()
    expect(trace.sessionHeaders.slice(1).every((s) => s === 'session-abc')).toBe(true)

    await client.disconnect()
  }, 15_000)

  test('a server that gives no session id works too', async () => {
    const { url, trace } = startServer()
    const client = createClient(url)

    await client.connect()
    await client.call('search', {})

    expect(trace.sessionHeaders.every((s) => s === null)).toBe(true)
    await client.disconnect()
  }, 15_000)
})

describe('error cases', () => {
  test('an HTTP error gives an understandable message', async () => {
    const { url } = startServer({ errorMethods: ['initialize'] })
    const client = createClient(url)

    await expect(client.connect()).rejects.toThrow(/400/)
  }, 15_000)

  test('the response body adds the reason to the error text', async () => {
    const { url } = startServer({ errorMethods: ['initialize'] })
    const client = createClient(url)

    await expect(client.connect()).rejects.toThrow(/the server refused/)
  }, 15_000)

  test('A NOTIFICATION error DOES NOT BRING DOWN the handshake', async () => {
    // Some servers return 4xx for `notifications/initialized` — since
    // `initialize` succeeded the connection has to stay alive
    const { url } = startServer({ errorMethods: ['notifications/initialized'] })
    const client = createClient(url)

    await client.connect()
    expect(client.isReady).toBe(true)

    const result = await client.call('search', { word: 'works anyway' })
    expect(result.content[0]?.text).toBe('found: works anyway')

    await client.disconnect()
  }, 15_000)

  test('a non-JSON response gives an error', async () => {
    const { url } = startServer({ garbage: true })
    const client = createClient(url)

    await expect(client.connect()).rejects.toThrow(/not JSON/)
  }, 15_000)

  test('a non-existent address gives an error', async () => {
    // Port 1 — the connection is refused
    const client = createClient('http://localhost:1/mcp')
    await expect(client.connect()).rejects.toThrow()
  }, 15_000)

  test('http does not connect without a url', async () => {
    const client = new McpClient({ transport: 'http' })
    await expect(client.connect()).rejects.toThrow(/url/)
  })

  test('a closed transport cannot be written to', async () => {
    const transport = createHttpTransport('http://localhost:1/mcp')
    await transport.close()
    await expect(transport.send({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow(/closed/)
  })
})

describe('parseSseMessages', () => {
  test('it reads a single data line', () => {
    const messages = parseSseMessages('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n')
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1 }])
  })

  test('it reads several events', () => {
    const text = 'data: {"jsonrpc":"2.0","id":1}\n\ndata: {"jsonrpc":"2.0","id":2}\n\n'
    expect(parseSseMessages(text)).toEqual([
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 2 },
    ])
  })

  test('it drops the lines that are not data', () => {
    const text = 'event: ping\nid: 42\nretry: 1000\ndata: {"jsonrpc":"2.0","id":1}\n\n'
    expect(parseSseMessages(text)).toEqual([{ jsonrpc: '2.0', id: 1 }])
  })

  test('it drops non-JSON data and reads the rest', () => {
    const text = 'data: garbage\n\ndata: {"jsonrpc":"2.0","id":2}\n\n'
    expect(parseSseMessages(text)).toEqual([{ jsonrpc: '2.0', id: 2 }])
  })

  test('it drops the [DONE] marker', () => {
    expect(parseSseMessages('data: [DONE]\n\n')).toEqual([])
  })

  test('empty text gives an empty list', () => {
    expect(parseSseMessages('')).toEqual([])
    expect(parseSseMessages('\n\n\n')).toEqual([])
  })
})
