import type { Migration } from './index.ts'

// The time layer: work that starts WITHOUT a human being present.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ TWO NEEDS, ONE TABLE.                                                │
// │                                                                      │
// │ `resume`    — the provider's rate limit ran out mid-conversation.    │
// │               The platform notices, reads when the limit resets and  │
// │               schedules ONE continuation in THAT SAME session.       │
// │               Created by the system, runs once, then it is done.     │
// │                                                                      │
// │ `recurring` — "prepare this report every day". A cron expression and │
// │               a prompt; every firing opens a NEW session, so the     │
// │               context never accumulates and yesterday's run cannot   │
// │               colour today's.                                        │
// │                                                                      │
// │ They share a table because they share the machinery: a due time, a   │
// │ tick that finds it, a run that is recorded. What differs is only     │
// │ what happens after the run — one row dies, the other re-arms.        │
// └──────────────────────────────────────────────────────────────────────┘
//
// WHY `run_at` IS AN INTEGER (epoch ms) WHILE EVERY OTHER TABLE USES TEXT.
// This is the only column in the schema that is COMPARED rather than
// displayed: the tick asks `run_at <= ?` several times a minute. ISO strings
// do compare correctly in SQLite when the timezone is fixed, but that is a
// property of the format, not a guarantee of the column — one row written as
// local time and the ordering silently breaks. An integer cannot be written
// ambiguously. `created_at`/`last_run_at` stay TEXT: they are shown to the
// user, never compared.
//
// `session_id` IS NULLABLE, AND THE `ON DELETE` DIFFERS BY KIND — which the
// schema cannot express, so it is written here:
//   - `resume` always has one. If the user deletes that conversation the
//     schedule is meaningless, and `ON DELETE CASCADE` removes it.
//   - `recurring` has one only for the LAST run (for display). Its next run
//     will open a fresh session, so the row must survive the old one.
//
// CASCADE serves the first case. The second was left UNPROTECTED here — this
// comment used to claim `scheduler.ts` cleared `session_id` first, and it does
// not. Deleting the conversation a scheduled run produced therefore deleted
// the schedule with it. **Migration 017 adds the trigger that actually
// enforces the rule**; read it before changing anything about this column.
//
// STATUS. 'active' — the tick will fire it. 'paused' — the user switched it
// off, it stays in the list. 'done' — a `resume` that has run (kept, not
// deleted: "why did my chat continue at 3am?" deserves an answer). 'failed'
// — the run threw and `last_error` says why; a `recurring` row still re-arms,
// because a report failing once is not a reason to stop reporting.

export const migration: Migration = {
  number: 16,
  name: 'schedules',
  sql: `
    CREATE TABLE schedules (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK (kind IN ('resume', 'recurring')),

      -- For 'resume' the session to continue; for 'recurring' the session the
      -- LAST run created (NULL before the first run). See the note above.
      session_id   TEXT REFERENCES chat_sessions (id) ON DELETE CASCADE,

      -- A recurring run opens its new session inside this project, so the work
      -- lands in the same folder every day. NULL = no project.
      project_id   TEXT REFERENCES projects (id) ON DELETE SET NULL,

      -- What is sent when it fires. For 'resume' this is the continuation
      -- nudge, for 'recurring' the standing instruction the user gave.
      prompt       TEXT NOT NULL,

      -- A 5-field cron expression. NULL for 'resume' — it fires once.
      cron         TEXT,

      -- The provider/model the run uses. NULL means "whatever the session is
      -- locked to" ('resume' always has one) or the platform default.
      provider     TEXT,
      model        TEXT,

      -- When it next fires — epoch ms, UTC. THE ONLY COMPARED COLUMN.
      run_at       INTEGER NOT NULL,

      status       TEXT NOT NULL CHECK (status IN ('active', 'paused', 'done', 'failed')),

      -- Who made it. 'system' = the rate-limit detector, 'agent' = the model
      -- asked through the permission layer, 'user' = the UI. Shown in the list,
      -- because "I never created this" needs an answer.
      created_by   TEXT NOT NULL CHECK (created_by IN ('user', 'agent', 'system')),

      -- A human-readable label for the list. The agent supplies one; the
      -- system builds it from the limit that was hit.
      title        TEXT NOT NULL,

      created_at   TEXT NOT NULL,
      last_run_at  TEXT,
      last_error   TEXT,
      runs         INTEGER NOT NULL DEFAULT 0
    );

    -- The tick's query: due rows only. 'active' first because it is the
    -- narrower of the two on a list that is mostly finished 'resume' rows.
    CREATE INDEX idx_schedules_due ON schedules (status, run_at);

    -- "Does this session already have a pending resume?" — asked on every
    -- provider error, so it should not scan.
    CREATE INDEX idx_schedules_session ON schedules (session_id);
  `,
}
