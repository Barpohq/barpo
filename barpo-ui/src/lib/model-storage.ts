// Remembering the last selected model in the browser.
//
// A separate file, because exporting a function from a component file breaks
// React Fast Refresh (oxlint warns about it).

const STORAGE_KEY = 'platform:model'

export interface StoredModel {
  provider: string
  model: string
}

export function readStoredModel(): StoredModel | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { provider?: unknown; model?: unknown }
    if (typeof v.provider === 'string' && typeof v.model === 'string') {
      return { provider: v.provider, model: v.model }
    }
  } catch {
    // malformed value or localStorage disabled — ignore
  }
  return null
}

export function storeModel(choice: StoredModel): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice))
  } catch {
    // localStorage may be disabled — not critical
  }
}
