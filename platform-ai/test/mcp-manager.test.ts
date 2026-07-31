// McpManager — the permission integration and the error isolation.
//
// THE MOST IMPORTANT CHECKS:
//   1) every tool call goes through `PermissionManager.sora()`;
//   2) a "deny" answer BLOCKS the call (the server is not called at all);
//   3) "always" does not call `sora()` on the second call at all;
//   4) secret arguments are REDACTED in the permission request;
//   5) when one server goes down the rest keep working.

import { afterEach, describe, expect, test } from 'bun:test'
import { argsToTarget, McpManager, mcpPattern } from '../src/mcp-manager.ts'
import { setProcessSpawner, type McpProcess } from '../src/mcp-transport.ts'
import { PermissionManager } from '../src/permission.ts'

afterEach(() => {
  setProcessSpawner(null)
})

// ---------------------------------------------------------------------------
// The fake process: its behaviour changes with the command name
// ---------------------------------------------------------------------------

interface Call {
  command: string
  toolName: string
  args: unknown
}

/**
 * Installs the process spawner.
 *
 * A process launched with a command name from the `failing` list does not
 * answer the handshake — it imitates the "the server failed to start" case.
 */
function setUpFake(failing: string[] = []): Call[] {
  const calls: Call[] = []

  setProcessSpawner((argv) => {
    const command = argv[0] ?? ''
    const fails = failing.includes(command)

    let output: ((b: string) => void) | undefined
    const proc: McpProcess = {
      yoz(text) {
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          const x = JSON.parse(line) as {
            id?: number
            method?: string
            params?: { name?: string; arguments?: unknown }
          }
          if (fails) continue // does not answer → timeout

          if (x.method === 'initialize') {
            sendAnswer(output, { jsonrpc: '2.0', id: x.id, result: {} })
            continue
          }
          if (x.method === 'notifications/initialized') continue
          if (x.method === 'tools/list') {
            sendAnswer(output, {
              jsonrpc: '2.0',
              id: x.id,
              result: {
                tools: [
                  { name: 'read', description: 'reading', inputSchema: { type: 'object' } },
                  { name: 'delete', description: 'deleting', inputSchema: { type: 'object' } },
                ],
              },
            })
            continue
          }
          if (x.method === 'tools/call') {
            calls.push({
              command,
              toolName: x.params?.name ?? '',
              args: x.params?.arguments,
            })
            sendAnswer(output, {
              jsonrpc: '2.0',
              id: x.id,
              result: { content: [{ type: 'text', text: `${command}:${x.params?.name} done` }] },
            })
          }
        }
      },
      chiqishniTingla(fn) {
        output = fn
      },
      xatoOqiminiTingla() {},
      toxtat() {},
      old() {},
      tugadi: Promise.resolve(0),
    }
    return proc
  })

  return calls
}

function sendAnswer(output: ((b: string) => void) | undefined, answer: unknown): void {
  queueMicrotask(() => output?.(`${JSON.stringify(answer)}\n`))
}

function serverSpec(id: string, name: string, command = name) {
  return {
    id,
    name,
    config: {
      transport: 'stdio' as const,
      command,
      handshakeTimeoutMs: 200,
      callTimeoutMs: 200,
    },
  }
}

/** A manager whose permission answers are decided up front */
function buildPermission(answer: 'allow' | 'deny' | 'always'): {
  permission: PermissionManager
  requests: { kind: string; action: string; target: string; pattern: string }[]
} {
  const permission = new PermissionManager('session-1')
  const requests: { kind: string; action: string; target: string; pattern: string }[] = []

  permission.kuzat((request) => {
    requests.push({
      kind: request.kind,
      action: request.action,
      target: request.target,
      pattern: request.pattern,
    })
    // We answer from inside the listener right away (as if a UI button were
    // pressed)
    queueMicrotask(() => permission.javobBer(request.id, answer))
  })

  return { permission, requests }
}

// ---------------------------------------------------------------------------

describe('connect', () => {
  test('the tool list is collected together with the server name', async () => {
    setUpFake()
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)

    await manager.connect([serverSpec('id-1', 'github'), serverSpec('id-2', 'slack')])

    expect(manager.connectedCount).toBe(2)
    const list = manager.list()
    expect(list).toHaveLength(4) // 2 tools per server
    expect(list.filter((r) => r.serverName === 'github').map((r) => r.tool.name)).toEqual([
      'read',
      'delete',
    ])

    await manager.close()
  })

  test('when one server goes down the rest keep working', async () => {
    setUpFake(['broken'])
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)

    await manager.connect([serverSpec('id-1', 'good'), serverSpec('id-2', 'broken')])

    expect(manager.connectedCount).toBe(1)
    expect(manager.list().every((r) => r.serverName === 'good')).toBe(true)
    expect(manager.connectionErrors.get('id-2')).toMatch(/did not respond/)

    await manager.close()
  })

  test('no error is thrown even when every server goes down', async () => {
    setUpFake(['a', 'b'])
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)

    await manager.connect([serverSpec('id-1', 'a'), serverSpec('id-2', 'b')])

    expect(manager.connectedCount).toBe(0)
    expect(manager.list()).toEqual([])
    expect(manager.connectionErrors.size).toBe(2)

    await manager.close()
  })

  test('connecting with an empty list is safe', async () => {
    setUpFake()
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)

    await manager.connect([])
    expect(manager.list()).toEqual([])
    await manager.close()
  })
})

describe('the permission flow', () => {
  test('every call goes through sora()', async () => {
    const calls = setUpFake()
    const { permission, requests } = buildPermission('allow')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await manager.call('id-1', 'read', { path: 'a.txt' })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.kind).toBe('mcp')
    expect(requests[0]?.action).toBe('github.read')
    expect(calls).toHaveLength(1)

    await manager.close()
  })

  test('DENY blocks the call — the server is not called at all', async () => {
    const calls = setUpFake()
    const { permission } = buildPermission('deny')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await expect(manager.call('id-1', 'delete', { path: 'important.txt' })).rejects.toThrow(
      /Permission denied/,
    )
    // THE MOST IMPORTANT PART: the server must not have been called
    expect(calls).toHaveLength(0)

    await manager.close()
  })

  test('ALWAYS does not call sora() on the second call', async () => {
    const calls = setUpFake()
    const { permission, requests } = buildPermission('always')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await manager.call('id-1', 'read', { path: 'a' })
    await manager.call('id-1', 'read', { path: 'b' })
    await manager.call('id-1', 'read', { path: 'c' })

    // Only the FIRST call raised a request
    expect(requests).toHaveLength(1)
    // But all three ran
    expect(calls).toHaveLength(3)

    await manager.close()
  })

  test('ALWAYS does not carry over to another tool (granularity)', async () => {
    setUpFake()
    const { permission, requests } = buildPermission('always')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await manager.call('id-1', 'read', {})
    await manager.call('id-1', 'delete', {}) // ANOTHER tool — it must be asked again

    expect(requests).toHaveLength(2)
    expect(requests.map((r) => r.pattern)).toEqual(['mcp:github.read', 'mcp:github.delete'])

    await manager.close()
  })

  test('the pattern contains the server and the tool name', async () => {
    setUpFake()
    const { permission, requests } = buildPermission('allow')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github'), serverSpec('id-2', 'slack')])

    await manager.call('id-1', 'read', {})
    await manager.call('id-2', 'read', {}) // the same tool name, another server

    expect(requests.map((r) => r.pattern)).toEqual(['mcp:github.read', 'mcp:slack.read'])

    await manager.close()
  })

  test('the reason text carries the server and the tool name', async () => {
    setUpFake()
    const permission = new PermissionManager('s1')
    const reasons: string[] = []
    permission.kuzat((request) => {
      reasons.push(request.reason)
      queueMicrotask(() => permission.javobBer(request.id, 'allow'))
    })

    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])
    await manager.call('id-1', 'read', {})

    expect(reasons[0]).toContain('github')
    expect(reasons[0]).toContain('read')

    await manager.close()
  })
})

describe('secret arguments', () => {
  test('a token is REDACTED in the permission request', async () => {
    setUpFake()
    const { permission, requests } = buildPermission('allow')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await manager.call('id-1', 'read', { token: 'ghp_abcdefghij1234567890', path: 'a.txt' })

    const target = requests[0]?.target ?? ''
    expect(target).not.toContain('ghp_abcdefghij1234567890')
    expect(target).toContain('redacted')
    // The non-secret part must stay visible — so the user knows what they are
    // granting permission to
    expect(target).toContain('a.txt')

    await manager.close()
  })

  test('the server gets the RAW argument — the redaction is only in the view', async () => {
    const calls = setUpFake()
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await manager.call('id-1', 'read', { token: 'ghp_abcdefghij1234567890' })

    // The redaction is only for the permission request — the real value must
    // reach the server
    expect(calls[0]?.args).toEqual({ token: 'ghp_abcdefghij1234567890' })

    await manager.close()
  })
})

describe('error cases', () => {
  test('a call to a server that is not connected throws with the reason', async () => {
    setUpFake(['broken'])
    const { permission, requests } = buildPermission('allow')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'broken')])

    await expect(manager.call('id-1', 'read', {})).rejects.toThrow(/not connected: broken/)
    // Permission IS NOT ASKED — raising a request for an action that cannot be
    // performed would only mislead the user
    expect(requests).toHaveLength(0)

    await manager.close()
  })

  test('an unknown serverId throws', async () => {
    setUpFake()
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await expect(manager.call('no-such-thing', 'read', {})).rejects.toThrow(/not found/)
    await manager.close()
  })

  test('calling close() twice is safe', async () => {
    setUpFake()
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)
    await manager.connect([serverSpec('id-1', 'github')])

    await manager.close()
    await manager.close()
    expect(manager.connectedCount).toBe(0)
  })

  test('connecting after it is closed does nothing', async () => {
    setUpFake()
    const { permission } = buildPermission('allow')
    const manager = new McpManager('s1', permission)

    await manager.close()
    await manager.connect([serverSpec('id-1', 'github')])
    expect(manager.connectedCount).toBe(0)
  })
})

describe('argsToTarget', () => {
  test('ordinary arguments come out as JSON', () => {
    expect(argsToTarget({ a: 1, b: 'text' })).toBe('{"a":1,"b":"text"}')
  })

  test('empty/undefined arguments become an empty object', () => {
    expect(argsToTarget(undefined)).toBe('{}')
    expect(argsToTarget(null)).toBe('{}')
  })

  test('secret keys are redacted', () => {
    const result = argsToTarget({ api_key: 'very-secret-value' })
    expect(result).not.toContain('very-secret-value')
    expect(result).toContain('redacted')
  })

  test('long arguments are truncated', () => {
    const long = argsToTarget({ text: 'a'.repeat(3000) })
    expect(long.length).toBeLessThanOrEqual(1001)
    expect(long.endsWith('…')).toBe(true)
  })

  test('a circular reference does not throw', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => argsToTarget(circular)).not.toThrow()
  })
})

describe('mcpPattern', () => {
  test('it is built from the server and the tool name', () => {
    expect(mcpPattern('github', 'create_issue')).toBe('mcp:github.create_issue')
  })

  test('a reverse-DNS name works too', () => {
    expect(mcpPattern('io.github.owner/repo', 'search')).toBe('mcp:io.github.owner/repo.search')
  })
})
