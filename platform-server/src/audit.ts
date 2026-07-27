// Audit log — platformadagi HAR bir amal shu yerdan o'tadi.
//
// Qoida: backendning istalgan qismi holat o'zgartirsa yoki maxfiy ma'lumot
// o'qisa, `auditYoz(...)` chaqirilishi SHART. Boshqa yo'l bilan audit_log
// jadvaliga yozmang — WS eventi yuborilmay qoladi va UI'dagi lenta jim turadi.
//
// Ikki ish qiladi: (1) append-only jadvalga yozadi, (2) WS hub orqali
// `audit.entry` eventini tarqatadi.

import type { Database } from 'bun:sqlite'
import type { AuditEntry, AuditLevel } from '@platforma/shared'
import { db as globalDb } from './db.ts'
import { hub } from './ws/hub.ts'

export type AuditResult = AuditEntry['result']

/** Vaqtni UI kutgan "HH:MM" ko'rinishida beradi */
function soatDaqiqa(sana: Date): string {
  const s = String(sana.getHours()).padStart(2, '0')
  const d = String(sana.getMinutes()).padStart(2, '0')
  return `${s}:${d}`
}

/**
 * Audit yozuvini bazaga qo'shadi va WS orqali tarqatadi.
 *
 * @param actor  kim bajardi ('firdavs', 'ai-news-bot', 'skill:postgres-backup'...)
 * @param action nima qilindi (inson o'qiy oladigan gap)
 * @param target qayerda / nimaga ('helsinki-1', 'post #4'...)
 * @param level  ruxsat darajasi: o'qish | o'zgartirish | xavfli
 * @param result natija: OK | tasdiqlandi | rad etildi | kutmoqda
 */
export function auditYoz(
  actor: string,
  action: string,
  target: string,
  level: AuditLevel,
  result: AuditResult = 'OK',
  baza?: Database,
): AuditEntry {
  const d = baza ?? globalDb()
  const hozir = new Date()

  const yozuv: AuditEntry = {
    time: soatDaqiqa(hozir),
    actor,
    action,
    target,
    level,
    result,
  }

  d.prepare(
    `INSERT INTO audit_log (time, actor, action, target, level, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(yozuv.time, actor, action, target, level, result, hozir.toISOString())

  hub.broadcast({ type: 'audit.entry', entry: yozuv })

  return yozuv
}

export interface AuditFiltr {
  level?: string
  actor?: string
  limit?: number
  offset?: number
}

/** Audit yozuvlarini filtr bilan o'qiydi — eng yangisi birinchi */
export function auditOqi(filtr: AuditFiltr = {}, baza?: Database): AuditEntry[] {
  const d = baza ?? globalDb()
  const shartlar: string[] = []
  const args: (string | number)[] = []

  if (filtr.level) {
    shartlar.push('level = ?')
    args.push(filtr.level)
  }
  if (filtr.actor) {
    shartlar.push('actor = ?')
    args.push(filtr.actor)
  }

  const where = shartlar.length ? `WHERE ${shartlar.join(' AND ')}` : ''
  const limit = Math.min(Math.max(filtr.limit ?? 100, 1), 1000)
  const offset = Math.max(filtr.offset ?? 0, 0)

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

/** Filtrga mos yozuvlarning umumiy soni (paginatsiya uchun) */
export function auditSoni(filtr: AuditFiltr = {}, baza?: Database): number {
  const d = baza ?? globalDb()
  const shartlar: string[] = []
  const args: string[] = []

  if (filtr.level) {
    shartlar.push('level = ?')
    args.push(filtr.level)
  }
  if (filtr.actor) {
    shartlar.push('actor = ?')
    args.push(filtr.actor)
  }

  const where = shartlar.length ? `WHERE ${shartlar.join(' AND ')}` : ''
  const qator = d
    .query<{ soni: number }, string[]>(`SELECT COUNT(*) AS soni FROM audit_log ${where}`)
    .get(...args)
  return qator?.soni ?? 0
}
