// A fake MCP server for tests — launched as a REAL PROCESS.
//
// It is brought up with `bun test/fixtures/fake-mcp-server.ts` and speaks
// newline-delimited JSON-RPC over stdin/stdout. That means the integration test
// checks the whole chain: `Bun.spawn` → writing to stdin → reading stdout → the
// process going down. A fake process (`setProcessSpawner`) cannot check that.
//
// The behaviour can be driven through env (the tests exercise various cases):
//   FAKE_SILENT=1      — answers nothing at all (a timeout test)
//   FAKE_ERROR=1       — returns a JSON-RPC error to `initialize`
//   FAKE_STDERR=text   — writes to stderr and exits immediately
//   FAKE_GARBAGE=1     — writes a non-JSON line to stdout before the response
//   FAKE_NO_SIGTERM=1  — ignores SIGTERM (a SIGKILL test)

const silent = process.env.FAKE_SILENT === '1'
const errorMode = process.env.FAKE_ERROR === '1'
const garbage = process.env.FAKE_GARBAGE === '1'

// Write to stderr and exit immediately — imitates the "failed to start" case
const stderrText = process.env.FAKE_STDERR
if (stderrText) {
  process.stderr.write(`${stderrText}\n`)
  process.exit(1)
}

if (process.env.FAKE_NO_SIGTERM === '1') {
  // A server that does not answer SIGTERM — the transport must move on to
  // SIGKILL
  process.on('SIGTERM', () => {})
}

function write(x: unknown): void {
  process.stdout.write(`${JSON.stringify(x)}\n`)
}

interface Incoming {
  id?: number
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

function respond(message: Incoming): void {
  if (silent) return

  const { id, method } = message

  if (method === 'initialize') {
    if (errorMode) {
      write({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'fake connection error' },
      })
      return
    }
    if (garbage) {
      // Some servers write a log to stdout — the protocol must not break
      process.stdout.write('DEBUG: the server started\n')
    }
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    })
    return
  }

  // A notification — no response is expected
  if (method === 'notifications/initialized') return

  if (method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Returns the input text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          {
            name: 'give_error',
            description: 'Always returns a failing result',
            inputSchema: { type: 'object', properties: {} },
          },
          // A tool with no schema — `parseTools` must fill it with an empty one
          { name: 'schemaless' },
        ],
      },
    })
    return
  }

  if (method === 'tools/call') {
    const name = message.params?.name
    if (name === 'give_error') {
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'deliberate error' }], isError: true },
      })
      return
    }
    if (name === 'echo') {
      const text = String(message.params?.arguments?.text ?? '')
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${text}` }] } })
      return
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } })
    return
  }

  write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } })
}

// We read stdin split into lines — the same logic as on the client side
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let nl: number
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      respond(JSON.parse(line) as Incoming)
    } catch {
      // we ignore a malformed line
    }
  }
})

// When stdin closes the server exits too — that is exactly what the client does
// in `yop()`
process.stdin.on('end', () => process.exit(0))
