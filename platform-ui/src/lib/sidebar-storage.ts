// Open/closed state of the Chat accordion in the sidebar.
//
// Persisted in the browser: if the user opens the list it should still be open
// on the next visit. The initial value is CLOSED, so the sidebar is compact on
// first sight.

const STORAGE_KEY = 'platform:sidebar-conversations'

export function isConversationsOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // localStorage disabled — stay closed
    return false
  }
}

export function storeConversationsOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? '1' : '0')
  } catch {
    // localStorage may be disabled — not critical
  }
}
