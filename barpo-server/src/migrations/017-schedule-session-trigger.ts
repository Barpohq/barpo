import type { Migration } from './index.ts'

// A recurring schedule must SURVIVE the deletion of its last run's session.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE BUG THIS FIXES, AND THE COMMENT THAT LIED ABOUT IT.              │
// │                                                                      │
// │ Migration 016 gave `schedules.session_id` an `ON DELETE CASCADE` and │
// │ explained it like this:                                              │
// │                                                                      │
// │     "`recurring` has one only for the LAST run (for display). Its    │
// │      next run will open a fresh session, so the row must survive     │
// │      the old one. CASCADE serves the first case; the second is       │
// │      protected by `scheduler.ts` clearing `session_id` before that   │
// │      can matter."                                                    │
// │                                                                      │
// │ `scheduler.ts` does no such thing. The protection was described but  │
// │ never written, and deleting the conversation a scheduled run had     │
// │ produced silently deleted THE SCHEDULE ITSELF — tidying up old chats │
// │ would quietly cancel the user's daily report.                        │
// │                                                                      │
// │ Found by deleting three test conversations and watching the          │
// │ schedule count drop to zero.                                         │
// └──────────────────────────────────────────────────────────────────────┘
//
// WHY A TRIGGER RATHER THAN CODE IN `deleteSession`. The rule has to hold for
// every path that removes a session: the REST route, a cascade from
// `projects`, a future bulk cleanup, a hand-written `DELETE` during
// maintenance. A check inside one function protects one caller; a trigger
// protects the table. This is the same reasoning as the append-only triggers
// on `audit_log`.
//
// THE TWO KINDS STILL DIFFER, which is the whole point:
//   `resume`    — its session IS the work. With the conversation gone there
//                 is nothing to continue, so it goes too (the FK still
//                 cascades).
//   `recurring` — its session is a LINK to the latest run, nothing more. The
//                 schedule outlives it; the link is simply cleared.
//
// The trigger runs BEFORE DELETE so the update lands while the row still
// exists; by the time the foreign key cascade fires, no `recurring` row points
// at that session any more and only `resume` rows are taken.

export const migration: Migration = {
  number: 17,
  name: 'schedule-session-trigger',
  sql: `
    CREATE TRIGGER schedules_keep_recurring
    BEFORE DELETE ON chat_sessions
    FOR EACH ROW
    BEGIN
      UPDATE schedules
         SET session_id = NULL
       WHERE session_id = OLD.id
         AND kind = 'recurring';
    END;
  `,
}
