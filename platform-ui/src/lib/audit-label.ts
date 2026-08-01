// Display labels for audit level and result values.
//
// The VALUES COME FROM THE DATABASE and are already English: the
// `CHECK (level IN ('read', 'write', 'dangerous'))` in
// `migrations/001-initial.ts` (plus the rename migration) locks them down, and
// `seed.ts` writes the same set into the `result` column. The maps stay in
// place so the display text can diverge from the stored value later without
// touching the schema.
//
// In a separate file rather than in `ui.tsx`: that file must only export
// components (Vite fast refresh).

import type { AuditLevel } from '@barpo/shared'

export const LEVEL_LABEL: Record<AuditLevel, string> = {
  read: 'read',
  write: 'write',
  dangerous: 'dangerous',
}

/**
 * The `result` column is free text — other values may occur in the database,
 * so the caller falls back to the raw value when a key is missing.
 */
export const RESULT_LABEL: Record<string, string> = {
  OK: 'OK',
  approved: 'approved',
  denied: 'denied',
  pending: 'pending',
}
