// Seed idempotentligi — qayta ishga tushirishda ma'lumot takrorlanmasligi kerak.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AppManifest } from '@platforma/shared'
import { bazaOch } from '../src/db.ts'
import { ilovaSaqla, ilovalarOqi } from '../src/repo.ts'
import { seedQol } from '../src/seed.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
})

afterEach(() => {
  db.close()
})

/** Sinov manifesti — seed'da ilova yo'q, shuning uchun testlar o'zi yaratadi */
const sinovIlova: AppManifest = {
  id: 'xarajat-bot',
  icon: '💸',
  name: 'xarajat-bot',
  tagline: 'Xarajat kuzatuvchi',
  version: 'v0.1.0',
  service: 'frankfurt-1 · docker',
  status: 'running',
  widgets: [{ type: 'note', text: 'sinov' }],
}

describe('seedQol', () => {
  test('birinchi chaqiruvda hamma jadval to\'ladi', () => {
    const natija = seedQol(db)
    expect(natija.audit).toBe(12)
    // Ilovalar seed'i ataylab bo'sh: dashboard haqiqiy manifestdan quriladi.
    expect(natija.apps).toBe(0)
    expect(ilovalarOqi(db)).toHaveLength(0)
  })

  test('ikkinchi chaqiruv hech narsa yozmaydi (idempotent)', () => {
    seedQol(db)
    const ikkinchi = seedQol(db)

    expect(ikkinchi).toEqual({ audit: 0, apps: 0 })
  })
})

describe('ilovaSaqla (upsert)', () => {
  test('yangi manifest qo\'shiladi, yangi:true qaytadi', () => {
    const { record, yangi } = ilovaSaqla(sinovIlova, db)

    expect(yangi).toBe(true)
    expect(record.id).toBe('xarajat-bot')
    expect(ilovalarOqi(db)).toHaveLength(1)
  })

  test('mavjud manifest yangilanadi, yangi:false qaytadi', () => {
    ilovaSaqla(sinovIlova, db)

    const { yangi } = ilovaSaqla({ ...sinovIlova, version: 'v9.9.9', status: 'idle' }, db)

    expect(yangi).toBe(false)
    expect(ilovalarOqi(db)).toHaveLength(1)
    expect(ilovalarOqi(db)[0]?.manifest.version).toBe('v9.9.9')
    expect(ilovalarOqi(db)[0]?.status).toBe('idle')
  })
})
