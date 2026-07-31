// Telling apart which billing model a provider was connected with.
//
// WHY IT MATTERS: one provider may arrive through two different channels — an
// OpenAI API key (every token is paid for) and the OpenAI Codex ChatGPT
// subscription (covered by the monthly fee). If the UI showed both the same
// way, the user would think they were on their subscription and end up using
// the paid channel. That is why `billing` is bound to the detection stage, not
// to how the UI looks.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BillingKind, ModelInfo } from '@platforma/shared'
import { claudeCodeAuth, codexAuth, localAuths } from '../src/local-auth.ts'
import { modelOrder } from '../src/detect.ts'

function createHome(): string {
  return mkdtempSync(join(tmpdir(), 'platforma-source-'))
}

const TOKEN = JSON.stringify({
  access_token: 'a',
  refresh_token: 'r',
  expires_at: 4_000_000_000_000,
})

describe('the local OAuth source name', () => {
  test("the Claude subscription returns a precise name — not a generic 'OAuth'", async () => {
    const home = createHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), TOKEN)

    const result = await claudeCodeAuth(home)
    // The user has to see which file it came from
    expect(result.found?.source).toContain('subscription')
    expect(result.found?.source).toContain('~/.claude')
    expect(result.found?.source).not.toBe('OAuth')
  })

  test('the ChatGPT subscription returns a precise name', async () => {
    const home = createHome()
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), TOKEN)

    const result = await codexAuth(home)
    expect(result.found?.source).toContain('subscription')
    expect(result.found?.source).toContain('~/.codex')
    expect(result.found?.source).not.toBe('OAuth')
  })

  test('every find gives a provider id and source pair', async () => {
    const home = createHome()
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), TOKEN)

    // `detect.ts` builds the `sources` map from this pair and puts it above
    // pi-ai's generic `chk.source` value
    const results = await localAuths(home)
    const found = results.filter((r) => r.found)
    expect(found.length).toBeGreaterThan(0)
    for (const r of found) {
      expect(r.found?.providerId).toBeTruthy()
      expect(r.found?.source).toBeTruthy()
    }
  })
})

function model(part: Partial<ModelInfo> & { name: string; billing: BillingKind }): ModelInfo {
  return {
    provider: part.billing === 'subscription' ? 'openai-codex' : 'openai',
    providerName: part.billing === 'subscription' ? 'OpenAI Codex' : 'OpenAI',
    id: part.name.toLowerCase(),
    contextWindow: 272_000,
    reasoning: false,
    vision: false,
    // Even on a subscription the catalogue price is above zero — the sorting
    // must not rely on it
    cost: { input: 1, output: 6 },
    source: 'test',
    ...part,
  }
}

describe('model order', () => {
  test('when the same model is on two channels the subscription comes first', () => {
    // What the user saw: in a search for "luna" the API key version was on top
    // and the subscription below — it has to be the other way round
    const list: ModelInfo[] = [
      model({ name: 'GPT-5.6 Luna', billing: 'apiKey' }),
      model({ name: 'GPT-5.6 Luna', billing: 'subscription' }),
    ]
    list.sort(modelOrder)
    expect(list[0]?.billing).toBe('subscription')
    expect(list[1]?.billing).toBe('apiKey')
  })

  test('the order is local > subscription > apiKey', () => {
    const list: ModelInfo[] = [
      model({ name: 'B key', billing: 'apiKey' }),
      model({ name: 'A local', billing: 'local' }),
      model({ name: 'C subscription', billing: 'subscription' }),
    ]
    list.sort(modelOrder)
    expect(list.map((m) => m.billing)).toEqual(['local', 'subscription', 'apiKey'])
  })

  test('the subscription stays on top even when it costs more than the key', () => {
    // The sorting relies on the billing channel, not on the price
    const list: ModelInfo[] = [
      model({ name: 'Cheap', billing: 'apiKey', cost: { input: 0.1, output: 0.2 } }),
      model({ name: 'Expensive', billing: 'subscription', cost: { input: 99, output: 99 } }),
    ]
    list.sort(modelOrder)
    expect(list[0]?.name).toBe('Expensive')
  })

  test('models of the same kind are sorted by name', () => {
    const list: ModelInfo[] = [
      model({ name: 'Zeta', billing: 'apiKey' }),
      model({ name: 'Alfa', billing: 'apiKey' }),
    ]
    list.sort(modelOrder)
    expect(list.map((m) => m.name)).toEqual(['Alfa', 'Zeta'])
  })
})
