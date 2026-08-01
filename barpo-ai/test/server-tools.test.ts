// The behaviour of the `serverList` tool: formatting, the source inversion,
// its conditional declaration and its agreement with the prompt.
//
// This tool has neither a file system nor SSH — it relies only on the function
// the caller supplies. That is why the tests work with a fake provider and
// depend on no external state.

import { describe, expect, test } from 'bun:test'
import { AGENT_SYSTEM_PROMPT } from '../src/agent.ts'
import {
  SERVER_PROMPT_SECTION,
  createServerListTool,
  serversToText,
  serverTools,
  serverToolsRaw,
  type ServerRecord,
} from '../src/server-tools.ts'

const web: ServerRecord = { name: 'web-1', host: '10.0.0.5', port: 22, username: 'root' }
const db: ServerRecord = { name: 'db-main', host: 'db.example.com', port: 2222, username: 'deploy' }

/** Runs the tool in the shape `agent.ts` calls it */
async function callTool(
  tool: ReturnType<typeof createServerListTool>,
): Promise<{ text: string; count: number | undefined }> {
  const result = await tool.execute(
    'id-1',
    {},
    undefined,
    undefined,
    { env: { cwd: '/any/where' } },
  )
  const text = result.content.map((b) => ('text' in b ? b.text : '')).join('')
  return { text, count: result.details?.count }
}

describe('serversToText', () => {
  test('the columns and the values come out', () => {
    const text = serversToText([web, db])
    expect(text).toContain('NAME')
    expect(text).toContain('HOST')
    expect(text).toContain('PORT')
    expect(text).toContain('USER')
    expect(text).toContain('web-1')
    expect(text).toContain('10.0.0.5')
    expect(text).toContain('db.example.com')
    expect(text).toContain('deploy')
  })

  test('a non-default port is shown too', () => {
    // The port is always shown so the agent knows whether `ssh -p` is needed
    expect(serversToText([db])).toContain('2222')
  })

  test('each server sits on its own line', () => {
    const lines = serversToText([web, db]).split('\n')
    expect(lines.filter((l) => l.startsWith('web-1'))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('db-main'))).toHaveLength(1)
  })

  test('an empty list — not an error, an explanation', () => {
    const text = serversToText([])
    expect(text).toContain('No servers are connected')
    // So the agent can tell the user what to do
    expect(text).toContain('Servers')
  })

  test('the ssh instruction comes along with the list', () => {
    // An agent that got a name should also know what to do with it
    expect(serversToText([web])).toContain('ssh')
  })
})

describe('the serverList tool', () => {
  test('it returns the servers from the provider', async () => {
    const { text, count } = await callTool(createServerListTool(() => [web, db]))
    expect(text).toContain('web-1')
    expect(text).toContain('db-main')
    expect(count).toBe(2)
  })

  test('an async provider is supported too', async () => {
    const { text, count } = await callTool(
      createServerListTool(async () => [web]),
    )
    expect(text).toContain('web-1')
    expect(count).toBe(1)
  })

  test('the provider is read afresh ON EVERY CALL', async () => {
    // The user may add a server during the conversation — the agent must not
    // be left looking at a stale list
    let list: ServerRecord[] = [web]
    const tool = createServerListTool(() => list)

    const first = await callTool(tool)
    expect(first.count).toBe(1)

    list = [web, db]
    const second = await callTool(tool)
    expect(second.count).toBe(2)
    expect(second.text).toContain('db-main')
  })

  test('it does not throw with an empty provider either', async () => {
    const { text, count } = await callTool(createServerListTool(() => []))
    expect(count).toBe(0)
    expect(text).toContain('No servers are connected')
  })

  test('it is called without parameters — the schema is an empty object', () => {
    const tool = createServerListTool(() => [])
    expect(tool.name).toBe('serverList')
    expect(tool.parameters).toBeDefined()
  })
})

describe('conditional declaration', () => {
  test('with no provider the tool is NOT THERE AT ALL', () => {
    // Better than "present, but always empty": the model then does not keep
    // trying a capability that is not there
    expect(serverToolsRaw(undefined)).toHaveLength(0)
    expect(serverTools(undefined)).toHaveLength(0)
  })

  test('with a provider one tool is declared', () => {
    const tools = serverToolsRaw(() => [web])
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('serverList')
  })

  test('the shape with the context attached works too', async () => {
    const tools = serverTools(() => [web])
    expect(tools).toHaveLength(1)
    const result = await (tools[0]! as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: { text?: string }[] }>
    }).execute('id-1', {})
    expect(result.content.map((b) => b.text ?? '').join('')).toContain('web-1')
  })
})

describe('agreement with the prompt', () => {
  test('with hasServers=true the tool is in the prompt list', () => {
    const prompt = AGENT_SYSTEM_PROMPT('/work', undefined, undefined, undefined, true)
    expect(prompt).toContain('serverList')
    // The instruction has to land too — the name alone is not enough
    expect(prompt).toContain('NEVER guess a server name')
  })

  test('with hasServers=false the prompt does not mention it at all', () => {
    // Writing about a tool that is not there would push the model towards a
    // capability it does not have
    const prompt = AGENT_SYSTEM_PROMPT('/work', undefined, undefined, undefined, false)
    expect(prompt).not.toContain('serverList')
  })

  test('the default — a call without the flag does not mention the tool', () => {
    expect(AGENT_SYSTEM_PROMPT('/work')).not.toContain('serverList')
  })

  test('the tool name in the prompt section equals the real tool name', () => {
    // Even though the two sit in one file, this test catches a renamed tool
    const name = serverToolsRaw(() => [])[0]?.name ?? 'serverList'
    expect(SERVER_PROMPT_SECTION.list.join(' ')).toContain(name)
  })
})
