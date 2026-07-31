// Model selection for the classifier.
//
// This logic was corrected several times during live testing — the test locks
// those findings in, otherwise a "cheaper" model could get picked in the
// future.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ModelInfo } from '@platforma/shared'
import { pickClassifierModel } from '../src/classifier.ts'

const ORIGINAL_ENV = process.env.PLATFORM_CLASSIFIER_MODEL

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PLATFORM_CLASSIFIER_MODEL
  else process.env.PLATFORM_CLASSIFIER_MODEL = ORIGINAL_ENV
})

function model(part: Partial<ModelInfo> & { provider: string; id: string }): ModelInfo {
  return {
    providerName: part.provider,
    name: part.id,
    contextWindow: 128_000,
    reasoning: false,
    vision: false,
    cost: { input: 1, output: 5 },
    source: 'test',
    billing: 'apiKey',
    ...part,
  }
}

describe('forcing through env', () => {
  test('PLATFORM_CLASSIFIER_MODEL beats everything', () => {
    process.env.PLATFORM_CLASSIFIER_MODEL = 'ollama/my-model'
    const picked = pickClassifierModel([model({ provider: 'openrouter', id: 'a/b' })])
    expect(picked).toEqual({ provider: 'ollama', model: 'my-model' })
  })

  test('a model id containing slashes is split correctly', () => {
    process.env.PLATFORM_CLASSIFIER_MODEL = 'openrouter/google/gemini-2.5-flash-lite'
    expect(pickClassifierModel([])).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-lite',
    })
  })
})

describe('unsuitable models are excluded', () => {
  test('models where thinking is mandatory are not picked', () => {
    // In testing: qwen3 gave no answer even after 90 seconds,
    // gpt-5-mini returned "Reasoning is mandatory for this endpoint"
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'ollama', id: 'qwen3:8b', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'openai/gpt-5-mini', cost: { input: 0.1, output: 0.4 } }),
      model({ provider: 'openrouter', id: 'deepseek/deepseek-r1', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'inclusionai/ling-2.6-flash', cost: { input: 2, output: 8 } }),
    ])
    expect(picked?.model).toBe('inclusionai/ling-2.6-flash')
  })

  test('obsolete generations are not picked', () => {
    // claude-3-haiku returned a provider error in testing
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'openrouter', id: 'anthropic/claude-3-haiku', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'meta/llama-3.3-70b', cost: { input: 5, output: 5 } }),
    ])
    expect(picked?.model).toBe('meta/llama-3.3-70b')
  })

  test('a model with a small context is not picked', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'x', id: 'small', contextWindow: 4096, cost: { input: 0, output: 0 } }),
      model({ provider: 'x', id: 'large', contextWindow: 128_000, cost: { input: 9, output: 9 } }),
    ])
    expect(picked?.model).toBe('large')
  })

  test('undefined when there is no suitable model', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    expect(pickClassifierModel([])).toBeUndefined()
    expect(
      pickClassifierModel([model({ provider: 'ollama', id: 'qwen3:0.6b' })]),
    ).toBeUndefined()
  })
})

describe('the tested models take priority', () => {
  test('gemini-2.5-flash-lite ranks highest (8/8, ~0.8s)', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'openrouter', id: 'inclusionai/ling-2.6-flash', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'google/gemini-2.5-flash-lite', cost: { input: 9, output: 9 } }),
    ])
    // The tested one is picked even though it costs more
    expect(picked?.model).toBe('google/gemini-2.5-flash-lite')
  })

  test('haiku-4.5 comes second (8/8, ~2.3s)', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'openrouter', id: 'inclusionai/ling-2.6-flash', cost: { input: 0, output: 0 } }),
      model({ provider: 'anthropic', id: 'claude-haiku-4-5', cost: { input: 1, output: 5 } }),
    ])
    expect(picked?.model).toBe('claude-haiku-4-5')
  })

  test('the reasoning flag does not get in the way of selection', () => {
    // Haiku and Gemini are `reasoning: true`, but thinking is optional — both
    // scored 8/8 in testing. Only the ones where it is MANDATORY are excluded.
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'openrouter', id: 'google/gemini-2.5-flash-lite', reasoning: true }),
    ])
    expect(picked?.model).toBe('google/gemini-2.5-flash-lite')
  })

  test('among the untested ones a fast family wins, then the cheaper one', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'x', id: 'large-model', cost: { input: 0, output: 0 } }),
      model({ provider: 'x', id: 'some-flash-lite', cost: { input: 5, output: 5 } }),
    ])
    expect(picked?.model).toBe('some-flash-lite')
  })
})
