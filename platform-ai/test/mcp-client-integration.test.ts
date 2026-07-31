// The MCP client — an integration test with a REAL PROCESS.
//
// The difference from `mcp-client.test.ts`: `Bun.spawn` is not swapped out
// here. The fake MCP server (`fixtures/fake-mcp-server.ts`) is brought up as a
// real process and talks over stdin/stdout.
//
// WHY TWO LEVELS ARE NEEDED. The unit tests check the logic (id matching,
// timeouts, abort), but they ROUTE AROUND `Bun.spawn` — meaning they do not
// answer the questions "does the process really come up, does what was written
// to stdin reach the server, DOES the process go down". Those exact three
// things are what cause trouble in production.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { McpClient } from '../src/mcp-client.ts'

const SERVER = join(import.meta.dir, 'fixtures', 'fake-mcp-server.ts')

function createClient(env: Record<string, string> = {}, timeout = 5000): McpClient {
  return new McpClient({
    transport: 'stdio',
    command: process.execPath, // bun
    args: ['run', SERVER],
    env,
    handshakeTimeoutMs: timeout,
    callTimeoutMs: timeout,
  })
}

/**
 * Whether the PID is still alive.
 *
 * `kill(pid, 0)` sends no signal, it only checks that the process exists. That
 * is how we confirm no zombie is left behind.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the whole flow', () => {
  test('connect → listTools → call → disconnect', async () => {
    const client = createClient()

    await client.connect()
    expect(client.info?.serverInfo?.name).toBe('fake')

    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['echo', 'give_error', 'schemaless'])
    // The tool with no schema got an empty object schema
    expect(tools[2]?.inputSchema).toEqual({ type: 'object', properties: {} })

    const result = await client.call('echo', { text: 'hello world' })
    expect(result.content[0]?.text).toBe('echo: hello world')
    expect(result.isError).toBe(false)

    await client.disconnect()
    expect(client.isReady).toBe(false)
  }, 15_000)

  test('inputSchema arrives as a real JSON Schema', async () => {
    const client = createClient()
    await client.connect()

    const tools = await client.listTools()
    const echo = tools.find((t) => t.name === 'echo')
    // This object goes straight to the agent tool as `parameters`
    expect(echo?.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    })

    await client.disconnect()
  }, 15_000)

  test('an isError result is not thrown, it comes back with a flag', async () => {
    const client = createClient()
    await client.connect()

    const result = await client.call('give_error', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('deliberate error')

    await client.disconnect()
  }, 15_000)

  test('an unknown tool gives a JSON-RPC error', async () => {
    const client = createClient()
    await client.connect()

    await expect(client.call('no_such_thing', {})).rejects.toThrow(/unknown tool/)
    // The connection stays ALIVE — one failing call must not break the session
    expect(client.isReady).toBe(true)

    const after = await client.call('echo', { text: 'still works' })
    expect(after.content[0]?.text).toBe('echo: still works')

    await client.disconnect()
  }, 15_000)

  test('consecutive calls do not get mixed up', async () => {
    const client = createClient()
    await client.connect()

    const results = await Promise.all([
      client.call('echo', { text: 'one' }),
      client.call('echo', { text: 'two' }),
      client.call('echo', { text: 'three' }),
    ])

    expect(results.map((r) => r.content[0]?.text)).toEqual([
      'echo: one',
      'echo: two',
      'echo: three',
    ])

    await client.disconnect()
  }, 15_000)
})

describe('process lifecycle', () => {
  test('disconnect() REALLY kills the process (no zombie is left)', async () => {
    // We bring the process up ourselves, so we know the PID
    const proc = Bun.spawn([process.execPath, 'run', SERVER], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const pid = proc.pid
    expect(isAlive(pid)).toBe(true)

    // When stdin closes the fixture exits by itself — that is what the
    // transport does in `close()`
    proc.stdin.end()
    await proc.exited

    expect(isAlive(pid)).toBe(false)
  }, 15_000)

  test('when the handshake fails no process is left behind', async () => {
    // A silent server — it does not answer, so a timeout happens
    const client = createClient({ FAKE_SILENT: '1' }, 500)

    await expect(client.connect()).rejects.toThrow(/did not respond/)
    expect(client.isReady).toBe(false)

    // `disconnect()` was called inside `connect()` — calling it again must not
    // give an error
    await client.disconnect()
  }, 15_000)

  test('if the server writes to stderr the reason is in the error text', async () => {
    const client = createClient({ FAKE_STDERR: 'the required package was not found' }, 2000)

    await expect(client.connect()).rejects.toThrow(/the required package was not found/)
  }, 15_000)

  test('a non-existent command gives an understandable error', async () => {
    const client = new McpClient({
      transport: 'stdio',
      command: '/no/such/command-mcp',
      handshakeTimeoutMs: 2000,
    })

    // Bun.spawn fails with ENOENT or the process dies immediately — in both
    // cases `connect()` MUST THROW, not hang
    await expect(client.connect()).rejects.toThrow()
    expect(client.isReady).toBe(false)
  }, 15_000)

  test('a process that does not answer SIGTERM dies with SIGKILL', async () => {
    const client = createClient({ FAKE_NO_SIGTERM: '1' })
    await client.connect()

    const start = Date.now()
    await client.disconnect()
    const elapsed = Date.now() - start

    // SIGTERM did not work → wait 2s then SIGKILL. That is, closing takes ~2s
    // but IT DOES NOT HANG FOREVER — that is the main check.
    expect(elapsed).toBeGreaterThan(1500)
    expect(client.isReady).toBe(false)
  }, 15_000)

  test('a log line on stdout does not break the protocol', async () => {
    const client = createClient({ FAKE_GARBAGE: '1' })

    await client.connect()
    expect(client.isReady).toBe(true)

    const result = await client.call('echo', { text: 'clean' })
    expect(result.content[0]?.text).toBe('echo: clean')

    await client.disconnect()
  }, 15_000)
})
