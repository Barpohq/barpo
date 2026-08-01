// Audit log — EVERY action on the platform passes through here.
//
// The rule: if any part of the backend changes state or reads secret data,
// calling `auditWrite(...)` is MANDATORY. Do not write to the audit_log table
// any other way — the WS event would not be sent and the feed in the UI would
// stay silent.
//
// It does two things: (1) appends to an append-only table, (2) broadcasts an
// `audit.entry` event through the WS hub.

import type { Database } from 'bun:sqlite'
import type { AuditEntry, AuditLevel } from '@barpo/shared'
import { db as globalDb } from './db.ts'
import { hub } from './ws/hub.ts'

export type AuditResult = AuditEntry['result']

/** Formats the time as the "HH:MM" the UI expects */
function hourMinute(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * Adds an audit entry to the database and broadcasts it over WS.
 *
 * @param actor  who did it ('firdavs', 'ai-news-bot', 'skill:postgres-backup'...)
 * @param action what was done (a sentence a human can read)
 * @param target where / on what ('helsinki-1', 'post #4'...)
 * @param level  the permission level: read | write | dangerous
 * @param result the outcome: OK | approved | denied | pending
 */
export function auditWrite(
  actor: string,
  action: string,
  target: string,
  level: AuditLevel,
  result: AuditResult = 'OK',
  database?: Database,
): AuditEntry {
  const d = database ?? globalDb()
  const now = new Date()

  const entry: AuditEntry = {
    time: hourMinute(now),
    actor,
    action,
    target,
    level,
    result,
  }

  d.prepare(
    `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.time, actor, action, target, level, result, now.toISOString())

  hub.broadcast({ type: 'audit.entry', entry })

  return entry
}

export interface AuditFilter {
  level?: string
  actor?: string
  limit?: number
  offset?: number
}

/** Reads audit entries with a filter — newest first */
export function auditRead(filter: AuditFilter = {}, database?: Database): AuditEntry[] {
  const d = database ?? globalDb()
  const conditions: string[] = []
  const args: (string | number)[] = []

  if (filter.level) {
    conditions.push('level = ?')
    args.push(filter.level)
  }
  if (filter.actor) {
    conditions.push('actor = ?')
    args.push(filter.actor)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
  const offset = Math.max(filter.offset ?? 0, 0)

  return d
    .query<AuditEntry, (string | number)[]>(
      `SELECT time, actor, action, target, level, result
         FROM audit_log
         ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset)
}

/** The total number of entries matching the filter (for pagination) */
export function auditCount(filter: AuditFilter = {}, database?: Database): number {
  const d = database ?? globalDb()
  const conditions: string[] = []
  const args: string[] = []

  if (filter.level) {
    conditions.push('level = ?')
    args.push(filter.level)
  }
  if (filter.actor) {
    conditions.push('actor = ?')
    args.push(filter.actor)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const row = d
    .query<{ count: number }, string[]>(`SELECT COUNT(*) AS count FROM audit_log ${where}`)
    .get(...args)
  return row?.count ?? 0
}
