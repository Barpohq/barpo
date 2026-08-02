// Presence — the data half: WHO else is in this project's directory.
//
// The formatting half (the prompt text) lives in `barpo-ai`
// (`presence-prompt.ts`) — the same split as `schedule-tools.ts` (ai) /
// the schedule repo functions here. This module only gathers: the sibling
// sessions from SQLite and the "streaming right now" mark.
//
// The streaming set is PASSED IN rather than read from `orchestrator.ts`:
// the running-stream registry is module state in the orchestrator, and the
// orchestrator imports this module — importing back would be a cycle. The
// same inversion the AI package uses for `serverProvider`.

import type { Sibling } from '@barpo/ai'
import { siblingSessions } from './repo.ts'
import type { Database } from 'bun:sqlite'

/**
 * The sibling conversations of a project session, marked with who is live.
 *
 * Empty for a session with no project — and then nothing at all is injected
 * into the prompt (see `presenceToPrompt`).
 */
export function sessionPresence(
  sessionId: string,
  streamingIds: ReadonlySet<string>,
  database?: Database,
): Sibling[] {
  return siblingSessions(sessionId, database).map((s) => ({
    title: s.title,
    streaming: streamingIds.has(s.id),
    updatedAt: s.updatedAt,
  }))
}
