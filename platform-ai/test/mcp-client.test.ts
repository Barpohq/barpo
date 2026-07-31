// The MCP client — unit tests (with no real process).
//
// The process is swapped out with `setProcessSpawner()` (the `setCommandRunner`
// style from `ssh.ts`), so these tests run fast and cases such as
// timeout/abort can be driven precisely.
//
// The full flow with a real process lives in `mcp-client-integration.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  MCP_PROTOCOL_VERSION,
  parseCallResult,
  parseTools,
} from '../src/mcp-protocol.ts'
import {
  setProcessSpawner,
  createStdioTransport,
  type McpProcess,
} from '../src/mcp-transport.ts'
import { McpClient } from '../src/mcp-client.ts'

afterEach(() => {
  setProcessSpawner(null)
})

// ---------------------------------------------------------------------------
// The fake process
// ---------------------------------------------------------------------------

interface FakeState {
  argv: string[]
  env: Record<string, string>
  written: string[]
  stopped: number
  killed: number
}

/**
 * Creates a fake process. `respond` decides what answer comes back for an
 * incoming message (returning undefined means no answer at all).
 */
function setUpFake(
  respond: (message: { id?: number; method?: string; params?: unknown }) => unknown,
  setting: { stderr?: string; noSigterm?: boolean } = {},
): FakeState {
  const state: FakeState = { argv: [], env: {}, written: [], stopped: 0, killed: 0 }

  setProcessSpawner((argv, env) => {
    state.argv = argv
    state.env = env

    let output: ((b: string) => void) | undefined
    let errorStream: ((b: string) => void) | undefined
    let finish: ((code: number) => void) | undefined
    const exited = new Promise<number>((r) => {
      finish = r
    })

    const proc: McpProcess = {
      write(text) {
        state.written.push(text)
        // We answer every incoming line
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
          const answer = respond(message)
          if (answer === undefined) continue
          // We deliver the answer after a MICROTASK — with a real process the
          // answer does not arrive immediately either, and `request()` has not
          // yet moved on to waiting
          queueMicrotask(() => output?.(`${JSON.stringify(answer)}\n`))
        }
      },
      onStdout(fn) {
        output = fn
        if (setting.stderr) queueMicrotask(() => errorStream?.(setting.stderr as string))
      },
      onStderr(fn) {
        errorStream = fn
      },
      stop() {
        state.stopped++
        if (!setting.noSigterm) finish?.(0)
      },
      kill() {
        state.killed++
        finish?.(137)
      },
      exited,
    }
    return proc
  })

  return state
}

/** The default responder — a server that works normally */
function normalResponse(message: { id?: number; method?: string; params?: unknown }): unknown {
  const { id, method } = message
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'fake', version: '1.0' },
      },
    }
  }
  if (method === 'notifications/initialized') return undefined
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }],
      },
    }
  }
  if (method === 'tools/call') {
    const p = message.params as { name?: string; arguments?: { text?: string } }
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo: ${p?.arguments?.text ?? ''}` }] },
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } }
}

function createClient(extra: Record<string, unknown> = {}): McpClient {
  return new McpClient({
    transport: 'stdio',
    command: 'fake-server',
    args: ['--test'],
    handshakeTimeoutMs: 200,
    callTimeoutMs: 200,
    ...extra,
  })
}

// ---------------------------------------------------------------------------

describe('handshake', () => {
  test('connects and serverInfo is stored', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient()

    await client.connect()
    expect(client.isReady).toBe(true)
    expect(client.info?.serverInfo?.name).toBe('fake')
    await client.disconnect()
  })

  test('argv is built from the command + the arguments', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient()
    await client.connect()

    expect(state.argv).toEqual(['fake-server', '--test'])
    await client.disconnect()
  })

  test('env is passed through', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient({ env: { TOKEN: 'secret' } })
    await client.connect()

    expect(state.env).toEqual({ TOKEN: 'secret' })
    await client.disconnect()
  })

  test('the initialized notification is sent after initialize', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient()
    await client.connect()

    const methods = state.written.map((m) => (JSON.parse(m.trim()) as { method: string }).method)
    expect(methods).toEqual(['initialize', 'notifications/initialized'])
    await client.disconnect()
  })

  test('connecting twice does not handshake again', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient()
    await client.connect()
    await client.connect()

    expect(state.written.filter((m) => m.includes('initialize')).length).toBe(2) // initialize + initialized
    await client.disconnect()
  })

  test('when the server does not answer: a timeout error and the process is closed', async () => {
    const state = setUpFake(() => undefined)
    const client = createClient()

    await expect(client.connect()).rejects.toThrow(/did not respond/)
    // The handshake failed — the process MUST NOT BE LEFT BEHIND
    expect(state.stopped).toBe(1)
    expect(client.isReady).toBe(false)
  })

  test('a JSON-RPC error shows up in the error text', async () => {
    setUpFake((x) => ({
      jsonrpc: '2.0',
      id: x.id,
      error: { code: -32000, message: 'no permission' },
    }))
    const client = createClient()

    await expect(client.connect()).rejects.toThrow(/no permission/)
  })

  test('the stderr text is appended to the error note', async () => {
    setUpFake(() => undefined, { stderr: 'npx: command not found' })
    const client = createClient()

    await expect(client.connect()).rejects.toThrow(/command not found/)
  })

  test('stdio does not connect without a command', async () => {
    const client = new McpClient({ transport: 'stdio' })
    await expect(client.connect()).rejects.toThrow(/command/)
  })

  test('http does not connect without a url', async () => {
    // The HTTP transport tests are in `mcp-http.test.ts` (with Bun.serve) —
    // here only the setting is checked
    const client = new McpClient({ transport: 'http' })
    await expect(client.connect()).rejects.toThrow(/url/)
  })

  test('an unknown transport throws', async () => {
    const client = new McpClient({ transport: 'grpc' as 'stdio' })
    await expect(client.connect()).rejects.toThrow(/Unknown transport/)
  })
})

describe('tools/list', () => {
  test('the tool list arrives', async () => {
    setUpFake(normalResponse)
    const client = createClient()
    await client.connect()

    const tools = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('echo')
    await client.disconnect()
  })

  test('the result is cached — a second request is not sent', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient()
    await client.connect()

    await client.listTools()
    await client.listTools()

    const listCount = state.written.filter((m) => m.includes('tools/list')).length
    expect(listCount).toBe(1)
    await client.disconnect()
  })

  test('calling it without connecting throws', async () => {
    setUpFake(normalResponse)
    const client = createClient()
    await expect(client.listTools()).rejects.toThrow(/not connected/)
  })
})

describe('tools/call', () => {
  test('the result text comes back', async () => {
    setUpFake(normalResponse)
    const client = createClient()
    await client.connect()

    const result = await client.call('echo', { text: 'hello' })
    expect(result.content[0]?.text).toBe('echo: hello')
    expect(result.isError).toBe(false)
    await client.disconnect()
  })

  test('an isError result DOES NOT THROW', async () => {
    setUpFake((x) => {
      if (x.method === 'initialize') return normalResponse(x)
      if (x.method === 'notifications/initialized') return undefined
      return {
        jsonrpc: '2.0',
        id: x.id,
        result: { content: [{ type: 'text', text: 'file not found' }], isError: true },
      }
    })
    const client = createClient()
    await client.connect()

    const result = await client.call('open', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('file not found')
    await client.disconnect()
  })

  test('a JSON-RPC error is thrown', async () => {
    setUpFake((x) => {
      if (x.method === 'initialize') return normalResponse(x)
      if (x.method === 'notifications/initialized') return undefined
      return { jsonrpc: '2.0', id: x.id, error: { code: -32601, message: 'no such tool' } }
    })
    const client = createClient()
    await client.connect()

    await expect(client.call('missing', {})).rejects.toThrow(/no such tool/)
    await client.disconnect()
  })

  test('a timeout when no answer arrives', async () => {
    setUpFake((x) => {
      if (x.method === 'initialize') return normalResponse(x)
      return undefined
    })
    const client = createClient()
    await client.connect()

    await expect(client.call('echo', {})).rejects.toThrow(/did not respond/)
    await client.disconnect()
  })

  test('an abort signal cuts the call off', async () => {
    setUpFake((x) => {
      if (x.method === 'initialize') return normalResponse(x)
      return undefined
    })
    const client = createClient()
    await client.connect()

    const controller = new AbortController()
    const waiting = client.call('echo', {}, controller.signal)
    controller.abort()

    await expect(waiting).rejects.toThrow(/cancelled/)
    await client.disconnect()
  })

  test('an already aborted signal rejects immediately', async () => {
    setUpFake(normalResponse)
    const client = createClient()
    await client.connect()

    const controller = new AbortController()
    controller.abort()
    await expect(client.call('echo', {}, controller.signal)).rejects.toThrow(/cancelled/)
    await client.disconnect()
  })

  test('parallel calls are separated by id', async () => {
    // We return the answers in REVERSE order — that is what checks the id
    // matching actually works
    const queue: { id: number; text: string }[] = []
    setProcessSpawner(() => {
      let output: ((b: string) => void) | undefined
      return {
        write(text) {
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            const x = JSON.parse(line) as {
              id?: number
              method?: string
              params?: { arguments?: { text?: string } }
            }
            if (x.method === 'initialize') {
              queueMicrotask(() =>
                output?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result: {} })}\n`),
              )
              continue
            }
            if (x.method === 'notifications/initialized') continue
            queue.push({ id: x.id ?? 0, text: x.params?.arguments?.text ?? '' })
            // Once two have piled up we answer in reverse order
            if (queue.length === 2) {
              for (const q of [...queue].reverse()) {
                queueMicrotask(() =>
                  output?.(
                    `${JSON.stringify({
                      jsonrpc: '2.0',
                      id: q.id,
                      result: { content: [{ type: 'text', text: q.text }] },
                    })}\n`,
                  ),
                )
              }
            }
          }
        },
        onStdout(fn) {
          output = fn
        },
        onStderr() {},
        stop() {},
        kill() {},
        exited: Promise.resolve(0),
      }
    })

    const client = createClient()
    await client.connect()

    const [one, two] = await Promise.all([
      client.call('echo', { text: 'one' }),
      client.call('echo', { text: 'two' }),
    ])

    expect(one.content[0]?.text).toBe('one')
    expect(two.content[0]?.text).toBe('two')
    await client.disconnect()
  })
})

describe('disconnect()', () => {
  test('it stops the process', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient()
    await client.connect()
    await client.disconnect()

    expect(state.stopped).toBe(1)
    expect(client.isReady).toBe(false)
  })

  test('calling it twice is safe', async () => {
    const state = setUpFake(normalResponse)
    const client = createClient()
    await client.connect()
    await client.disconnect()
    await client.disconnect()

    expect(state.stopped).toBe(1)
  })

  test('a pending request is rejected', async () => {
    setUpFake((x) => {
      if (x.method === 'initialize') return normalResponse(x)
      return undefined
    })
    const client = createClient({ callTimeoutMs: 5000 })
    await client.connect()

    const waiting = client.call('echo', {})
    await client.disconnect()

    await expect(waiting).rejects.toThrow(/was closed/)
  })

  test('connecting after it is closed is not possible', async () => {
    setUpFake(normalResponse)
    const client = createClient()
    await client.connect()
    await client.disconnect()

    await expect(client.connect()).rejects.toThrow(/closed/)
  })
})

describe('transport resilience', () => {
  test('a non-JSON line on stdout does not break the protocol', async () => {
    setProcessSpawner(() => {
      let output: ((b: string) => void) | undefined
      return {
        write(text) {
          const x = JSON.parse(text.trim()) as { id?: number; method?: string }
          if (x.method !== 'initialize') return
          queueMicrotask(() => {
            // The server wrote a log, then the real answer
            output?.('the server started\n')
            output?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result: {} })}\n`)
          })
        },
        onStdout(fn) {
          output = fn
        },
        onStderr() {},
        stop() {},
        kill() {},
        exited: Promise.resolve(0),
      }
    })

    const client = createClient()
    await client.connect()
    expect(client.isReady).toBe(true)
    await client.disconnect()
  })

  test('a message split into chunks is reassembled', async () => {
    setProcessSpawner(() => {
      let output: ((b: string) => void) | undefined
      return {
        write(text) {
          const x = JSON.parse(text.trim()) as { id?: number; method?: string }
          if (x.method !== 'initialize') return
          const answer = JSON.stringify({ jsonrpc: '2.0', id: x.id, result: { ok: true } })
          // A message may arrive split into TCP/pipe chunks
          queueMicrotask(() => {
            output?.(answer.slice(0, 10))
            output?.(answer.slice(10))
            output?.('\n')
          })
        },
        onStdout(fn) {
          output = fn
        },
        onStderr() {},
        stop() {},
        kill() {},
        exited: Promise.resolve(0),
      }
    })

    const client = createClient()
    await client.connect()
    expect(client.isReady).toBe(true)
    await client.disconnect()
  })

  test('a closed transport cannot be written to', async () => {
    setUpFake(normalResponse)
    const transport = createStdioTransport('a', [])
    await transport.close()

    await expect(transport.send({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow(/closed/)
  })

  test('SIGKILL is sent when SIGTERM goes unanswered', async () => {
    const state = setUpFake(normalResponse, { noSigterm: true })
    const transport = createStdioTransport('a', [])

    // `yop()` waits for the SIGKILL timer — KILL_GRACE_MS (2s)
    await transport.close()

    expect(state.stopped).toBe(1)
    expect(state.killed).toBe(1)
  }, 10_000)
})

describe('protocol parsing', () => {
  test('a malformed tool definition is dropped, the rest stays', () => {
    const tools = parseTools({
      tools: [
        { name: 'good', inputSchema: { type: 'object' } },
        { nom: 'unnamed' }, // no `name`
        null,
        'string',
        { name: '' }, // an empty name
        { name: 'schemaless' },
      ],
    })

    expect(tools.map((t) => t.name)).toEqual(['good', 'schemaless'])
    // A tool with no schema gets an empty object schema — so the provider
    // request does not break
    expect(tools[1]?.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  test('an empty list when tools is not an array', () => {
    expect(parseTools({})).toEqual([])
    expect(parseTools({ tools: 'nope' })).toEqual([])
    expect(parseTools(null)).toEqual([])
  })

  test('non-text content turns into a placeholder', () => {
    const result = parseCallResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'base64...' },
      ],
    })

    expect(result.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(result.content[1]?.text).toContain('image')
  })

  test('empty text when there is no content', () => {
    expect(parseCallResult({}).content).toEqual([{ type: 'text', text: '' }])
    expect(parseCallResult(null).content).toEqual([{ type: 'text', text: '' }])
  })
})
