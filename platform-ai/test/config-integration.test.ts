// Are the config settings really applied?
//
// A config that nobody reads is of no use. These tests exercise the
// setting → behaviour chain: if the value changes, does the behaviour change
// too?
//
// Only the places that need no LLM call are tested — those are pure logic.

import { describe, expect, test } from 'bun:test'
import { defaultConfig } from '@platforma/config'
import { pickClassifierModel } from '../src/classifier.ts'
import { ModeManager } from '../src/mode.ts'
import { PermissionManager } from '../src/permission.ts'
import type { ModelInfo } from '@platforma/shared'

function model(id: string, provider = 'p'): ModelInfo {
  return {
    provider,
    providerName: provider,
    id,
    name: id,
    contextWindow: 100_000,
    reasoning: false,
    vision: false,
    cost: { input: 1, output: 1 },
    source: 'key',
    billing: 'apiKey',
  }
}

describe('the mode limits come from the config', () => {
  test('the default limit is 3 consecutive blocks', () => {
    const m = new ModeManager('s1')
    m.set('auto')
    expect(m.blocked()).toBe(false)
    expect(m.blocked()).toBe(false)
    // Auto turns off on the third
    expect(m.blocked()).toBe(true)
    expect(m.mode).toBe('confirm')
  })

  test('the limit from the config is applied', () => {
    const m = new ModeManager('s2')
    m.setLimits(1, 50)
    m.set('auto')
    // It turns off on the first block
    expect(m.blocked()).toBe(true)
    expect(m.mode).toBe('confirm')
    expect(m.reason).toContain('1 actions in a row')
  })

  test('the total limit comes from the config too', () => {
    const m = new ModeManager('s3')
    m.setLimits(100, 2)
    m.set('auto')
    m.blocked()
    // We reset the consecutive counter to zero; the total one stays
    m.allowed()
    expect(m.blocked()).toBe(true)
    expect(m.reason).toContain('2 actions were blocked')
  })

  test('an invalid limit is ignored', () => {
    // Config validation should catch this, but this is the second line of defence
    const m = new ModeManager('s4')
    m.setLimits(0, -5)
    m.set('auto')
    expect(m.blocked()).toBe(false)
    expect(m.blocked()).toBe(false)
    expect(m.blocked()).toBe(true) // the default 3 is kept
  })
})

describe('the permission wait deadline comes from the config', () => {
  test('when the deadline passes it is DENIED, permission is not granted', async () => {
    // The most important behaviour: a timeout never turns into an automatic allow
    const manager = new PermissionManager('s5')
    manager.setWaitTimeout(30)
    const answer = await manager.ask({
      kind: 'command',
      action: 'bash',
      target: 'rm x',
      reason: 'test',
      pattern: 'rm',
    })
    expect(answer).toBe('deny')
  })

  test('an invalid deadline is ignored', () => {
    const manager = new PermissionManager('s6')
    // It must not throw
    expect(() => manager.setWaitTimeout(-1)).not.toThrow()
    expect(() => manager.setWaitTimeout(Number.NaN)).not.toThrow()
  })
})

describe('the classifier model comes from the config', () => {
  const models = [model('claude-haiku-4.5', 'anthropic'), model('gemini-2.5-flash-lite', 'google')]

  test('it is chosen automatically when the config gives nothing', () => {
    const picked = pickClassifierModel(models)
    expect(picked).toBeDefined()
    // The tested models take priority
    expect(picked?.model).toBe('gemini-2.5-flash-lite')
  })

  test('the model from the config wins', () => {
    const picked = pickClassifierModel(models, 'anthropic/claude-haiku-4.5')
    expect(picked).toEqual({ provider: 'anthropic', model: 'claude-haiku-4.5' })
  })

  test('a null config falls back to automatic selection', () => {
    const picked = pickClassifierModel(models, null)
    expect(picked?.model).toBe('gemini-2.5-flash-lite')
  })

  test('a malformed config value is ignored', () => {
    // The `provider/model` shape is broken — we fall back to automatic selection
    const picked = pickClassifierModel(models, 'model-without-provider')
    expect(picked?.model).toBe('gemini-2.5-flash-lite')
  })

  test('the env variable BEATS the config', () => {
    // Env is for working around a temporary failure, so it has to override the
    // permanent setting
    const previous = process.env.PLATFORM_CLASSIFIER_MODEL
    process.env.PLATFORM_CLASSIFIER_MODEL = 'env/model'
    try {
      const picked = pickClassifierModel(models, 'config/model')
      expect(picked).toEqual({ provider: 'env', model: 'model' })
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_CLASSIFIER_MODEL
      else process.env.PLATFORM_CLASSIFIER_MODEL = previous
    }
  })
})

describe('the default config values are sensible', () => {
  test('the tool list contains every existing tool', () => {
    const config = defaultConfig()
    for (const name of ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']) {
      expect(config.agent.tools.enabled, `${name} is missing from the default list`).toContain(name)
    }
  })

  test('compaction is enabled by default', () => {
    // If it were off a long conversation would stop fitting — a bad default
    expect(defaultConfig().agent.compaction.enabled).toBe(true)
  })

  test('the initial mode is confirm (the safer side)', () => {
    expect(defaultConfig().permission.mode).toBe('confirm')
  })

  test('the kept tokens need not be smaller than the reserve, but both must fit in the context window', () => {
    const config = defaultConfig()
    const total = config.agent.compaction.reserveTokens + config.agent.compaction.keptTokens
    // The smallest widespread context window is ~128k
    expect(total).toBeLessThan(128_000)
  })
})
