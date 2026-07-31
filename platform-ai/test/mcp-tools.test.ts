// Declaring MCP tools to the agent.
//
// THE MAIN CHECKS:
//   1) with no manager given no tool is declared AT ALL (the agent does not
//      know MCP exists);
//   2) if two servers offer the same tool name the names DO NOT COLLIDE;
//   3) the JSON Schema passes through with no conversion;
//   4) a call goes through the permission layer (the wrapper does not route
//      around it).

import { afterEach, describe, expect, test } from 'bun:test'
import { AGENT_SYSTEM_PROMPT } from '../src/agent.ts'
import { McpManager } from '../src/mcp-manager.ts'
import {
  MCP_PROMPT_SECTION,
  MCP_TOOL_PREFIX,
  isMcpTool,
  mcpTools,
  mcpToolsRaw,
  mcpToolName,
  safeToolName,
} from '../src/mcp-tools.ts'
import { setProcessSpawner, type McpProcess } from '../src/mcp-transport.ts'
import { PermissionManager } from '../src/permission.ts'

afterEach(() => {
  setProcessSpawner(null)
})

/** A fake process that records the name of every tool that gets called */
function setUpFake(toolNames: string[]): { called: string[] } {
  const called: string[] = []

  setProcessSpawner(() => {
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
          const answer = (result: unknown) =>
            queueMicrotask(() =>
              output?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result })}\n`),
            )

          if (x.method === 'initialize') answer({})
          else if (x.method === 'tools/list') {
            answer({
              tools: toolNames.map((name) => ({
                name,
                description: `${name} description`,
                inputSchema: { type: 'object', properties: { word: { type: 'string' } } },
              })),
            })
          } else if (x.method === 'tools/call') {
            called.push(x.params?.name ?? '')
            answer({ content: [{ type: 'text', text: `${x.params?.name} done` }] })
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

  return { called }
}

function serverSpec(id: string, name: string) {
  return {
    id,
    name,
    config: {
      transport: 'stdio' as const,
      command: 'fake',
      handshakeTimeoutMs: 200,
      callTimeoutMs: 200,
    },
  }
}

/** A manager that grants every request immediately */
function buildPermission(answer: 'allow' | 'deny' = 'allow'): PermissionManager {
  const permission = new PermissionManager('session-1')
  permission.subscribe((request) => {
    queueMicrotask(() => permission.answer(request.id, answer))
  })
  return permission
}

async function buildManager(
  servers: { id: string; name: string }[],
  answer: 'allow' | 'deny' = 'allow',
): Promise<McpManager> {
  const manager = new McpManager('s1', buildPermission(answer))
  await manager.connect(servers.map((s) => serverSpec(s.id, s.name)))
  return manager
}

// ---------------------------------------------------------------------------

describe('with no manager given', () => {
  test('the raw list is empty', () => {
    expect(mcpToolsRaw(undefined)).toEqual([])
    expect(mcpTools(undefined)).toEqual([])
  })

  test('a manager with no connected server also gives an empty list', async () => {
    setUpFake(['echo'])
    const manager = new McpManager('s1', buildPermission())
    // connect() WAS NOT CALLED
    expect(mcpToolsRaw(manager)).toEqual([])
  })
})

describe('declaring tools', () => {
  test('the name is prefixed', async () => {
    setUpFake(['echo', 'search'])
    const manager = await buildManager([{ id: 'id-1', name: 'github' }])

    const tools = mcpToolsRaw(manager)
    expect(tools.map((t) => t.name)).toEqual(['mcp__github__echo', 'mcp__github__search'])
    // `label` is the same — this is what shows on the UI card
    expect(tools[0]?.label).toBe('mcp__github__echo')

    await manager.close()
  })

  test('the server name shows up in the description', async () => {
    setUpFake(['echo'])
    const manager = await buildManager([{ id: 'id-1', name: 'github' }])

    expect(mcpToolsRaw(manager)[0]?.description).toBe('[MCP: github] echo description')
    await manager.close()
  })

  test('the JSON Schema passes through WITH NO CONVERSION', async () => {
    setUpFake(['echo'])
    const manager = await buildManager([{ id: 'id-1', name: 'github' }])

    // The schema the server gave must become `parameters` exactly as it is
    expect(mcpToolsRaw(manager)[0]?.parameters).toEqual({
      type: 'object',
      properties: { word: { type: 'string' } },
    })

    await manager.close()
  })

  test('TWO SERVERS with the same tool name — the names do not collide', async () => {
    setUpFake(['search'])
    const manager = await buildManager([
      { id: 'id-1', name: 'github' },
      { id: 'id-2', name: 'slack' },
    ])

    const names = mcpToolsRaw(manager).map((t) => t.name)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    expect(names.sort()).toEqual(['mcp__github__search', 'mcp__slack__search'])

    await manager.close()
  })
})

describe('calling', () => {
  test('the tool runs and a result comes back', async () => {
    const { called } = setUpFake(['echo'])
    const manager = await buildManager([{ id: 'id-1', name: 'github' }])

    const tool = mcpTools(manager)[0]!
    const result = (await tool.execute(
      'c1',
      { word: 'hello' } as never,
      undefined,
      undefined as never,
    )) as {
      content: { text: string }[]
      details?: { serverName: string; toolName: string; isError?: boolean }
    }

    // IMPORTANT: the ORIGINAL name, WITHOUT the prefix, must reach the server
    expect(called).toEqual(['echo'])
    expect(result.content[0]?.text).toBe('echo done')
    expect(result.details).toEqual({ serverName: 'github', toolName: 'echo', isError: false })

    await manager.close()
  })

  test('WHEN PERMISSION IS DENIED the wrapper is blocked too', async () => {
    const { called } = setUpFake(['echo'])
    const manager = await buildManager([{ id: 'id-1', name: 'github' }], 'deny')

    const tool = mcpTools(manager)[0]!
    await expect(tool.execute('c1', {} as never, undefined, undefined as never)).rejects.toThrow(
      /Permission denied/,
    )

    // The tool wrapper DOES NOT ROUTE AROUND the permission
    expect(called).toEqual([])
    await manager.close()
  })

  test('an isError result reaches the agent as a failure', async () => {
    setProcessSpawner(() => {
      let output: ((b: string) => void) | undefined
      return {
        yoz(text) {
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            const x = JSON.parse(line) as { id?: number; method?: string }
            const answer = (result: unknown) =>
              queueMicrotask(() =>
                output?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result })}\n`),
              )
            if (x.method === 'initialize') answer({})
            else if (x.method === 'tools/list') answer({ tools: [{ name: 'echo' }] })
            else if (x.method === 'tools/call') {
              answer({ content: [{ type: 'text', text: 'permission was not enough' }], isError: true })
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
    })

    const manager = await buildManager([{ id: 'id-1', name: 'github' }])
    const tool = mcpTools(manager)[0]!
    const result = (await tool.execute('c1', {} as never, undefined, undefined as never)) as {
      content: { text: string }[]
      details?: { serverName: string; toolName: string; isError?: boolean }
    }

    // `AgentToolResult` carries no `isError` field, so the failure is marked
    // in the detail and in the text — the agent must SEE the failure
    expect(result.details?.isError).toBe(true)
    expect(result.content[0]?.text).toContain('The MCP tool reported an error')
    expect(result.content[0]?.text).toContain('permission was not enough')
    await manager.close()
  })
})

describe('name helpers', () => {
  test('safeToolName cleans up a reverse-DNS name', () => {
    expect(safeToolName('io.github.owner/repo')).toBe('io_github_owner_repo')
    expect(safeToolName('plain-name_2')).toBe('plain-name_2')
    expect(safeToolName('!!!')).toBe('___')
    expect(safeToolName('')).toBe('nomalum')
  })

  test('mcpToolName adds the prefix and the separator', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(mcpToolName('io.example/srv', 'search')).toBe('mcp__io_example_srv__search')
  })

  test('isMcpTool tells them apart by the prefix', () => {
    expect(isMcpTool('mcp__github__echo')).toBe(true)
    expect(isMcpTool('bash')).toBe(false)
    expect(isMcpTool('serverList')).toBe(false)
    expect(MCP_TOOL_PREFIX).toBe('mcp__')
  })
})

describe('prompt', () => {
  test('with no MCP the prompt DOES NOT MENTION it', () => {
    const prompt = AGENT_SYSTEM_PROMPT('/work', undefined, undefined, undefined, false, false, false)
    expect(prompt).not.toContain('mcp__')
    expect(prompt).not.toContain('MCP')
  })

  test('with MCP present the section is added', () => {
    const prompt = AGENT_SYSTEM_PROMPT('/work', undefined, undefined, undefined, false, false, true)
    expect(prompt).toContain('mcp__<server>__<tool>')
    expect(prompt).toContain('MCP TOOLS')
    // There must be a warning about the external effect
    expect(prompt).toContain('EXTERNAL systems')
  })

  test('the prompt section consists of two parts', () => {
    expect(MCP_PROMPT_SECTION.list.length).toBeGreaterThan(0)
    expect(MCP_PROMPT_SECTION.rules.length).toBeGreaterThan(0)
  })
})
