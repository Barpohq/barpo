// Model selection for the classifier.
//
// This logic was corrected several times during live testing — the test locks
// those findings in, otherwise a "cheaper" model could get picked in the
// future.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ModelInfo } from '@barpo/shared'
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

// ===========================================================================
// The classifier follows the CHAT's provider
// ===========================================================================

describe('the chat provider decides where the classifier comes from', () => {
  /**
   * ┌────────────────────────────────────────────────────────────────────┐
   * │ THE BUG THIS PREVENTS, in full, because it cost a real scheduled   │
   * │ run and was invisible from the UI.                                 │
   * │                                                                    │
   * │ The chat ran on an `openai-codex` SUBSCRIPTION. Selection scanned  │
   * │ every detected model, scored `openai/gpt-4.1-nano` cheapest, and   │
   * │ picked it — a PAID API model on a different billing channel. The   │
   * │ chat worked fine. The classifier answered "You have no credits     │
   * │ remaining", auto mode shut itself off, and the unattended run died │
   * │ mid-command. Nothing in the settings looked wrong.                 │
   * └────────────────────────────────────────────────────────────────────┘
   */
  const mixed = () => [
    model({ provider: 'openai', id: 'gpt-4.1-nano', cost: { input: 0.1, output: 0.4 } }),
    model({ provider: 'openai-codex', id: 'gpt-5.6-luna', cost: { input: 0.2, output: 1.2 } }),
    model({ provider: 'openai-codex', id: 'gpt-5.4', cost: { input: 2.5, output: 15 } }),
    model({ provider: 'anthropic', id: 'claude-sonnet-5', cost: { input: 3, output: 15 } }),
    model({ provider: 'anthropic', id: 'claude-haiku-4-5-20251001', cost: { input: 1, output: 5 } }),
  ]

  test('a subscription chat does NOT fall through to a paid API model', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel(mixed(), null, 'openai-codex')
    expect(picked?.provider).toBe('openai-codex')
    // …and specifically the cheap one, not the fast-but-expensive one
    expect(picked?.model).toBe('gpt-5.6-luna')
  })

  test('each provider gets its own written-down choice', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    expect(pickClassifierModel(mixed(), null, 'openai')?.model).toBe('gpt-4.1-nano')
    expect(pickClassifierModel(mixed(), null, 'anthropic')?.model).toBe('claude-sonnet-5')
  })

  test('Anthropic uses SONNET, not the cheaper Haiku', () => {
    // A deliberate exception to "cheapest capable": the classifier is the only
    // thing standing between an unattended agent and a destructive command,
    // and the expensive mistake is the subtle injection nobody wrote a test
    // for. Haiku is listed as the fallback, not the first choice.
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel(mixed(), null, 'anthropic')
    expect(picked?.model).toBe('claude-sonnet-5')
  })

  test('the table order wins over the catalogue order', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    // `gpt-5.4` is listed FIRST here; the table still prefers luna.
    const reversed = [
      model({ provider: 'openai-codex', id: 'gpt-5.4' }),
      model({ provider: 'openai-codex', id: 'gpt-5.6-luna' }),
    ]
    expect(pickClassifierModel(reversed, null, 'openai-codex')?.model).toBe('gpt-5.6-luna')
  })

  test('the next entry is used when the first is not on the account', () => {
    // A provider exposes different models to different plans, which is why
    // the table holds second and third choices.
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const partial = [model({ provider: 'openai-codex', id: 'gpt-5.4-nano' })]
    expect(pickClassifierModel(partial, null, 'openai-codex')?.model).toBe('gpt-5.4-nano')
  })

  test('a provider with no table entry falls back to the heuristic WITHIN it', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const models = [
      model({ provider: 'openai', id: 'gpt-4.1-nano', cost: { input: 0.1, output: 0.4 } }),
      model({ provider: 'exotic-provider', id: 'big-model', cost: { input: 9, output: 9 } }),
      model({ provider: 'exotic-provider', id: 'small-model', cost: { input: 1, output: 1 } }),
    ]
    const picked = pickClassifierModel(models, null, 'exotic-provider')
    expect(picked?.provider).toBe('exotic-provider')
    expect(picked?.model).toBe('small-model')
  })

  test('it leaves the provider only when nothing there can do the job', () => {
    // A local Ollama holding only `qwen3` — which never leaves its <think>
    // stage. Auto mode should still work rather than being lost entirely.
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const models = [
      model({ provider: 'ollama', id: 'qwen3:8b', cost: { input: 0, output: 0 } }),
      model({ provider: 'openai', id: 'gpt-4.1-nano', cost: { input: 0.1, output: 0.4 } }),
    ]
    const picked = pickClassifierModel(models, null, 'ollama')
    expect(picked?.provider).toBe('openai')
  })

  test('with no chat provider given the old global behaviour applies', () => {
    // Callers that genuinely have no session (a config screen, a diagnostic)
    // must keep working.
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    expect(pickClassifierModel(mixed(), null)).toBeDefined()
  })

  test('config and env still outrank the chat provider', () => {
    // The user's explicit choice is not overridden by a heuristic, however
    // well-motivated.
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    expect(pickClassifierModel(mixed(), 'google/gemini-2.5-flash-lite', 'openai-codex')).toEqual({
      provider: 'google',
      model: 'gemini-2.5-flash-lite',
    })

    process.env.PLATFORM_CLASSIFIER_MODEL = 'xai/grok-3-mini'
    expect(pickClassifierModel(mixed(), 'google/gemini-2.5-flash-lite', 'openai-codex')).toEqual({
      provider: 'xai',
      model: 'grok-3-mini',
    })
  })
})

describe('the gpt-5 exclusion is narrow enough to be useful', () => {
  // It used to be `\bgpt-5`, which matched the whole later family and left a
  // Codex-only account with no candidate at all — the very failure above.
  test('the bare gpt-5 generation is still excluded', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'openai', id: 'gpt-5', cost: { input: 0, output: 0 } }),
      model({ provider: 'openai', id: 'gpt-5-mini', cost: { input: 0, output: 0 } }),
      model({ provider: 'openrouter', id: 'openai/gpt-5-mini', cost: { input: 0, output: 0 } }),
      model({ provider: 'openai', id: 'gpt-4.1-nano', cost: { input: 9, output: 9 } }),
    ])
    // Every gpt-5 variant is skipped even though they are free
    expect(picked?.model).toBe('gpt-4.1-nano')
  })

  test('the later gpt-5.x family is NOT excluded — it was measured working', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel([
      model({ provider: 'openai-codex', id: 'gpt-5.4-mini', cost: { input: 0.75, output: 4.5 } }),
    ])
    expect(picked?.model).toBe('gpt-5.4-mini')
  })

  test('codex-spark is excluded — the catalogue lists it, the API refuses it', () => {
    delete process.env.PLATFORM_CLASSIFIER_MODEL
    const picked = pickClassifierModel(
      [
        model({ provider: 'openai-codex', id: 'gpt-5.3-codex-spark', cost: { input: 0, output: 0 } }),
        model({ provider: 'openai-codex', id: 'gpt-5.6-luna', cost: { input: 9, output: 9 } }),
      ],
      null,
      'openai-codex',
    )
    expect(picked?.model).toBe('gpt-5.6-luna')
  })
})
