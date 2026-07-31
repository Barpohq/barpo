// Ollama — a local LLM server running on the user's own machine.
//
// pi-ai does not know it in its catalogue (which models exist depends on
// what the user has downloaded), so we build it at runtime with
// `createProvider()`: we fetch the model list from `/api/tags` and register
// each one as an OpenAI-compatible model (on its `/v1` endpoint Ollama
// emulates the OpenAI Chat Completions API).
//
// If Ollama is not running that is not an error but an ordinary state:
// `undefined` is returned and detection carries on.

import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

export const OLLAMA_ID = 'ollama'
export const OLLAMA_SOURCE = 'Ollama (local)'

/** The `OLLAMA_HOST` env var is supported (Ollama's own convention) */
export function ollamaBaseUrl(): string {
  const raw = process.env.OLLAMA_HOST?.trim()
  if (!raw) return 'http://127.0.0.1:11434'
  // OLLAMA_HOST is sometimes written without a scheme: "localhost:11434"
  const full = /^https?:\/\//.test(raw) ? raw : `http://${raw}`
  return full.replace(/\/+$/, '')
}

interface TagsResponse {
  models?: {
    name?: unknown
    details?: { parameter_size?: unknown; family?: unknown }
  }[]
}

/**
 * Fetches the list of models available in Ollama. If the server does not
 * answer, or the answer is not in the expected shape — an empty array.
 */
export async function ollamaModels(timeout = 800): Promise<string[]> {
  const baseUrl = ollamaBaseUrl()
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) return []
    const body = (await response.json()) as TagsResponse
    if (!Array.isArray(body.models)) return []
    return body.models
      .map((m) => (typeof m?.name === 'string' ? m.name : null))
      .filter((n): n is string => n !== null)
  } catch {
    // Ollama is not installed or not running — a normal state
    return []
  }
}

/**
 * The Ollama context window is not reliably reported in the model metadata,
 * hence a cautious default value. If a large context is needed, the user
 * configures `num_ctx` on the Ollama side.
 */
const DEFAULT_CONTEXT = 32_768

/**
 * Guesses the reasoning mode from the model name.
 *
 * Ollama does not report this in the metadata, but knowing it matters:
 * reasoning models go through a long `<think>` phase before answering. In
 * testing, qwen3:8b did not return JSON even after 90 seconds — which is why
 * they must not be picked for the classifier.
 */
function isReasoning(name: string): boolean {
  return /\b(qwen3|deepseek-r1|r1|marco-o1|qwq|reasoning|think)/i.test(name)
}

function ollamaModel(name: string, baseUrl: string): Model<'openai-completions'> {
  return {
    id: name,
    name,
    api: 'openai-completions',
    provider: OLLAMA_ID,
    baseUrl: `${baseUrl}/v1`,
    reasoning: isReasoning(name),
    input: ['text'],
    // A local model — free as far as billing is concerned
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT,
    maxTokens: 4096,
    compat: {
      // Ollama does not support these OpenAI extensions
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
  }
}

/**
 * Builds the Ollama provider from the models that were found.
 * `undefined` if no model was found — adding an empty provider to the list
 * would be pointless.
 */
export async function ollamaProvider(): Promise<Provider<'openai-completions'> | undefined> {
  const names = await ollamaModels()
  if (names.length === 0) return undefined

  const baseUrl = ollamaBaseUrl()
  return createProvider({
    id: OLLAMA_ID,
    name: 'Ollama',
    baseUrl: `${baseUrl}/v1`,
    // Ollama does not ask for authentication, but the OpenAI-compatible
    // layer refuses to run without a key ("No API key for provider"). So we
    // give it a symbolic key — Ollama ignores it. This is standard practice
    // for OpenAI-compatible local servers (vLLM, LM Studio) as well.
    auth: {
      apiKey: {
        name: 'Ollama (local, no key needed)',
        resolve: async () => ({ auth: { apiKey: 'ollama' }, source: OLLAMA_SOURCE }),
      },
    },
    models: names.map((n) => ollamaModel(n, baseUrl)),
    api: openAICompletionsApi(),
  })
}
