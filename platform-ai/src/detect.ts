// Detecting the AI providers available on the user's PC.
//
// Three sources, all three independent — if one fails the rest keep working:
//
//   1) Environment variables — the ~38 providers pi-ai knows about
//      (OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...).
//      `models.checkAuth(id)` tells us whether one is configured.
//   2) Ollama — a local server; ollama.ts builds it for us.
//   3) Local OAuth — subscription tokens in the ~/.claude and ~/.codex files;
//      local-auth.ts reads them and we place them in the credential store.
//
// The result is cached: re-checking 38 providers on every chat request (some
// of which go out to the network) is wasteful. `detectModels({ force: true })`
// refreshes the cache.

import type {
  DetectWarning,
  BillingKind,
  ModelInfo,
  ProviderInfo,
} from '@barpo/shared'
import type { Api, Model, Models, MutableModels } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { FileCredentialStore } from './credentials.ts'
import { localAuths } from './local-auth.ts'
import { OLLAMA_ID, OLLAMA_SOURCE, ollamaProvider } from './ollama.ts'

export interface DetectResult {
  models: ModelInfo[]
  providers: ProviderInfo[]
  warnings: DetectWarning[]
  /** When detection finished (ISO) */
  time: string
}

export interface DetectOptions {
  /** Bypass the cache and detect again */
  force?: boolean
  /** Credential file path (tests pass a different path) */
  credentialsPath?: string
}

/** Default credential file — it sits next to the DB */
export const DEFAULT_CREDENTIALS_PATH = new URL(
  '../../platform-server/data/ai-auth.json',
  import.meta.url,
).pathname

/**
 * Expiry reserve: we refresh the token this long before it expires.
 *
 * pi-ai itself only refreshes once the token HAS EXPIRED
 * (`Date.now() >= expires`). When writing to the store we bring `expires`
 * forward by this much — so pi-ai refreshes a day early and the user never
 * ends up in the "the token stopped working" state.
 *
 * Why exactly 1 day? A Codex access_token lives for 10 days, so the reserve
 * is ~10% of its lifetime. That keeps a one-day outage (PC switched off, no
 * internet) from killing the token, while not rotating needlessly often.
 */
export const EXPIRY_MARGIN = 24 * 60 * 60 * 1000

/**
 * The ones usable without extra payment go on top: local (free), then
 * subscription (covered by the monthly payment), and finally the API key
 * (every token is billed).
 */
const BILLING_ORDER: Record<BillingKind, number> = { local: 0, subscription: 1, apiKey: 2 }

/**
 * The ordering of the model list.
 *
 * IMPORTANT: `cost === 0` cannot be relied on here — the `cost` field of
 * subscription models holds the catalogue API price, but the user does not
 * pay per token for it. When one model is available over both channels (for
 * example gpt-5.6-luna: OPENAI_API_KEY and a ~/.codex subscription), the
 * subscription one must appear first — otherwise the user unknowingly picks
 * the paid channel.
 */
export function modelOrder(a: ModelInfo, b: ModelInfo): number {
  const billingDiff = BILLING_ORDER[a.billing] - BILLING_ORDER[b.billing]
  if (billingDiff !== 0) return billingDiff
  if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName)
  return a.name.localeCompare(b.name)
}

let _cache: DetectResult | null = null
let _models: Models | null = null
let _running: Promise<DetectResult> | null = null

/**
 * The pi-ai collection filled with the detected providers.
 * If `detectModels()` has not been called it is called automatically.
 */
export async function modelsCollection(options?: DetectOptions): Promise<Models> {
  if (!_models || options?.force) await detectModels(options)
  // detectModels always sets _models
  return _models as Models
}

/** The latest detection result (null if nothing has been detected yet) */
export function cachedResult(): DetectResult | null {
  return _cache
}

/** For tests: clear the cache */
export function clearCache(): void {
  _cache = null
  _models = null
  _running = null
}

/**
 * For tests: put a ready-made result into the cache.
 *
 * `_models` (the pi-ai collection) is LEFT ALONE — it requires a real
 * provider connection. That is, this function is only for exercising code
 * that relies on `cachedResult()`: the model list, the `vision` flag, the
 * prices. An LLM call will not work anyway, and that is deliberate — a test
 * must not go out to the network.
 */
export function setCache(result: DetectResult | null): void {
  _cache = result
}

export async function detectModels(options?: DetectOptions): Promise<DetectResult> {
  if (_cache && !options?.force) return _cache
  // If two requests arrive at once — one detects, the other waits
  if (_running && !options?.force) return _running

  _running = runDetection(options).finally(() => {
    _running = null
  })
  return _running
}

async function runDetection(options?: DetectOptions): Promise<DetectResult> {
  const warnings: DetectWarning[] = []
  const store = new FileCredentialStore(options?.credentialsPath ?? DEFAULT_CREDENTIALS_PATH)
  const models = builtinModels({ credentials: store }) as MutableModels

  // Provider id → exact source name. pi-ai's `checkAuth` only returns a
  // generic 'OAuth', while we know which file it came from — ours wins.
  const sources = new Map<string, string>()

  // --- Source 3 first: local OAuth is written to the store, because
  // checkAuth also takes stored credentials into account ---
  await attachLocalAuths(store, warnings, sources)

  // --- Source 2: Ollama ---
  try {
    const ollama = await ollamaProvider()
    if (ollama) {
      models.setProvider(ollama)
      sources.set(OLLAMA_ID, OLLAMA_SOURCE)
    } else {
      warnings.push({
        source: 'Ollama',
        reason: 'the local server did not respond or no models are loaded',
      })
    }
  } catch (error) {
    warnings.push({ source: 'Ollama', reason: errorText(error) })
  }

  // --- Source 1: env keys + the credentials written above ---
  const providers: ProviderInfo[] = []
  const modelList: ModelInfo[] = []

  for (const provider of models.getProviders()) {
    let source: string | undefined
    let billing: BillingKind = 'apiKey'
    try {
      const chk = await models.checkAuth(provider.id)
      if (!chk) continue // not configured — it does not make the list
      // The exact name (local OAuth file / Ollama) wins over the generic `chk.source`
      source = sources.get(provider.id) ?? chk.source ?? (chk.type === 'oauth' ? 'OAuth' : 'apiKey')
      billing =
        provider.id === OLLAMA_ID ? 'local' : chk.type === 'oauth' ? 'subscription' : 'apiKey'
    } catch (error) {
      warnings.push({ source: provider.name, reason: errorText(error) })
      continue
    }

    let providerModels: readonly Model<Api>[]
    try {
      providerModels = models.getModels(provider.id)
    } catch (error) {
      warnings.push({ source: provider.name, reason: errorText(error) })
      continue
    }
    if (providerModels.length === 0) continue

    providers.push({
      id: provider.id,
      name: provider.name,
      source,
      billing,
      modelCount: providerModels.length,
    })

    for (const m of providerModels) {
      modelList.push({
        provider: provider.id,
        providerName: provider.name,
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        vision: m.input.includes('image'),
        cost: { input: m.cost.input, output: m.cost.output },
        source,
        billing,
      })
    }
  }

  modelList.sort(modelOrder)
  // Providers follow the same order — the UI builds its groups from the model
  // order, and the two lists must not contradict each other
  providers.sort((a, b) => {
    const billingDiff = BILLING_ORDER[a.billing] - BILLING_ORDER[b.billing]
    return billingDiff !== 0 ? billingDiff : a.name.localeCompare(b.name)
  })

  _models = models
  _cache = { models: modelList, providers, warnings, time: new Date().toISOString() }
  return _cache
}

/**
 * Copies the ~/.claude and ~/.codex tokens into the credential store.
 * Writes the exact name into `sources` ("~/.codex (ChatGPT subscription)") —
 * it is then used in preference to pi-ai's generic "OAuth" string.
 */
async function attachLocalAuths(
  store: FileCredentialStore,
  warnings: DetectWarning[],
  sources: Map<string, string>,
): Promise<void> {
  let results: Awaited<ReturnType<typeof localAuths>>
  try {
    results = await localAuths()
  } catch (error) {
    // localAuths should not throw by itself, but this is a protective layer
    warnings.push({ source: 'Local OAuth', reason: errorText(error) })
    return
  }

  for (const result of results) {
    if (!result.found) {
      if (result.reason) warnings.push({ source: 'Local OAuth', reason: result.reason })
      continue
    }
    const { providerId, source, credential } = result.found
    sources.set(providerId, source)
    // We bring the expiry forward by the reserve — pi-ai then refreshes a day
    // before it runs out. If `expires` is 0 (expiry unknown) it stays 0: we do
    // not push it negative, as that would change its meaning.
    const withMargin: typeof credential = {
      ...credential,
      expires: credential.expires > 0 ? credential.expires - EXPIRY_MARGIN : 0,
    }
    try {
      await store.modify(providerId, async (current) => {
        // If the store already holds a newer token — leave it alone. pi-ai may
        // have been refreshing it itself, while the one in the local file may
        // be stale.
        //
        // Important: we do not rewrite it even when the token is identical.
        // Otherwise every detection would make `modify` trigger a write to the
        // source file.
        if (current?.type === 'oauth') {
          if (current.access === withMargin.access) return undefined
          if (current.expires > withMargin.expires) return undefined
        }
        return withMargin
      })
    } catch (error) {
      warnings.push({
        source: result.found.source,
        reason: `could not write to the store: ${errorText(error)}`,
      })
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
