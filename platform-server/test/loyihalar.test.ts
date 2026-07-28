// Loyihalar (project / workspace): migratsiya 005, route'lar, sessiya
// bog'lanishi va ish papkasi tanlash mantig'i.
//
// Fayl tizimiga tegadigan testlar vaqtinchalik papkada ishlaydi —
// `PLATFORMA_LOYIHALAR` env shu papkaga qaratiladi, ya'ni haqiqiy
// `~/.platforma/loyihalar` ga tegilmaydi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSession, Project } from '@platforma/shared'
import { app } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  ishPapkasi,
  loyihaPapkasiniYarat,
  loyihalarIldizi,
  loyihaSlugi,
  sessiyaIshPapkasi,
} from '../src/ish-papkasi.ts'
import {
  loyihaNomBoyicha,
  loyihaOqi,
  loyihalarOqi,
  loyihaYarat,
  sessiyaLoyihaPapkasi,
  sessiyaOqi,
  sessiyalarOqi,
  sessiyaYarat,
} from '../src/repo.ts'

let db: Database
let vaqtinchalik: string
let eskiLoyihalar: string | undefined
let eskiIshlar: string | undefined

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)

  vaqtinchalik = mkdtempSync(join(tmpdir(), 'platforma-loyiha-'))
  eskiLoyihalar = process.env.PLATFORMA_LOYIHALAR
  eskiIshlar = process.env.PLATFORMA_ISHLAR
  process.env.PLATFORMA_LOYIHALAR = join(vaqtinchalik, 'loyihalar')
  process.env.PLATFORMA_ISHLAR = join(vaqtinchalik, 'ishlar')
})

afterEach(() => {
  dbOrnat(null)
  db.close()

  if (eskiLoyihalar === undefined) delete process.env.PLATFORMA_LOYIHALAR
  else process.env.PLATFORMA_LOYIHALAR = eskiLoyihalar
  if (eskiIshlar === undefined) delete process.env.PLATFORMA_ISHLAR
  else process.env.PLATFORMA_ISHLAR = eskiIshlar

  rmSync(vaqtinchalik, { recursive: true, force: true })
})

async function loyihaSora(nom: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const javob = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: nom }),
  })
  return { status: javob.status, body: (await javob.json()) as Record<string, unknown> }
}

// ---------------------------------------------------------------------------

describe('migratsiya 005 — loyihalar sxemasi', () => {
  test('projects jadvali kerakli ustunlar bilan yaratiladi', () => {
    const ustunlar = db
      .query<{ name: string }, []>('PRAGMA table_info(projects)')
      .all()
      .map((u) => u.name)
    expect(ustunlar).toEqual(['id', 'name', 'papka', 'created_at'])
  })

  test('chat_sessions ga project_id ustuni qo\'shiladi', () => {
    const ustunlar = db
      .query<{ name: string }, []>('PRAGMA table_info(chat_sessions)')
      .all()
      .map((u) => u.name)
    expect(ustunlar).toContain('project_id')
  })

  test('loyiha nomi UNIQUE — bir xil nom ikki marta yozilmaydi', () => {
    db.prepare('INSERT INTO projects (id, name, papka, created_at) VALUES (?, ?, ?, ?)').run(
      'a',
      'bir xil',
      '/tmp/a',
      '2026-07-28T10:00:00.000Z',
    )
    expect(() =>
      db.prepare('INSERT INTO projects (id, name, papka, created_at) VALUES (?, ?, ?, ?)').run(
        'b',
        'bir xil',
        '/tmp/b',
        '2026-07-28T10:00:01.000Z',
      ),
    ).toThrow()
  })

  test('mavjud bo\'lmagan loyihaga ulangan sessiya yozilmaydi (foreign key)', () => {
    expect(() =>
      db
        .prepare(
          'INSERT INTO chat_sessions (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('s1', 'sinov', 'yoq-loyiha', '2026-07-28T10:00:00.000Z', '2026-07-28T10:00:00.000Z'),
    ).toThrow()
  })

  test('eski sessiya (project_id NULL) o\'qilaveradi', () => {
    const s = sessiyaYarat('loyihasiz', db)
    expect(s.projectId).toBeUndefined()
    expect(sessiyaOqi(s.id, db)?.projectId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('loyihaSlugi — papka nomining xavfsizligi', () => {
  test('oddiy nom o\'zgarmaydi', () => {
    expect(loyihaSlugi('bot')).toBe('bot')
    expect(loyihaSlugi('my_project-2')).toBe('my_project-2')
  })

  test('bo\'shliqlar chiziqchaga aylanadi', () => {
    expect(loyihaSlugi('mening loyiham')).toBe('mening-loyiham')
  })

  test('yo\'l hiylalari papka nomiga o\'tmaydi', () => {
    // Eng muhim tekshiruv: slug ildizdan chiqib keta olmasin
    for (const xavfli of ['../../etc', '..', '/etc/passwd', 'a/../../b', './..']) {
      const slug = loyihaSlugi(xavfli)
      if (slug !== null) {
        expect(slug).not.toContain('/')
        expect(slug).not.toContain('..')
        expect(slug).toMatch(/^[a-zA-Z0-9_-]+$/)
      }
    }
  })

  test('faqat nuqta va slashdan iborat nom null qaytaradi', () => {
    expect(loyihaSlugi('..')).toBeNull()
    expect(loyihaSlugi('///')).toBeNull()
    expect(loyihaSlugi('...')).toBeNull()
  })

  test('lotin harfi yo\'q nom (emoji, kirill) null qaytaradi', () => {
    expect(loyihaSlugi('🚀🚀')).toBeNull()
    expect(loyihaSlugi('проект')).toBeNull()
    expect(loyihaSlugi('   ')).toBeNull()
  })

  test('NUL va boshqa maxsus belgilar tashlanadi', () => {
    const slug = loyihaSlugi('bot\0zararli')
    expect(slug).toBe('bot-zararli')
  })

  test('juda uzun nom kesiladi', () => {
    const slug = loyihaSlugi('a'.repeat(200))
    expect(slug?.length).toBe(60)
  })

  test('natija har doim faqat xavfsiz belgilardan iborat', () => {
    for (const nom of ['a b/c', 'x@y.z', "nom'bilan", 'tab\there', 'yangi\nqator']) {
      const slug = loyihaSlugi(nom)
      if (slug !== null) expect(slug).toMatch(/^[a-zA-Z0-9_-]+$/)
    }
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/projects', () => {
  test('loyiha yaratiladi va papkasi haqiqatda paydo bo\'ladi', async () => {
    const { status, body } = await loyihaSora('Mening boti')
    expect(status).toBe(201)

    const loyiha = body.project as Project
    expect(loyiha.name).toBe('Mening boti')
    expect(loyiha.papka).toBe(join(loyihalarIldizi(), 'Mening-boti'))
    expect(existsSync(loyiha.papka)).toBe(true)
  })

  test('papka ildizi PLATFORMA_LOYIHALAR ichida qoladi', async () => {
    const { body } = await loyihaSora('../qochish urinishi')
    const loyiha = body.project as Project
    expect(loyiha.papka.startsWith(loyihalarIldizi())).toBe(true)
    expect(loyiha.papka).not.toContain('..')
  })

  test('nom bo\'sh bo\'lsa 400', async () => {
    expect((await loyihaSora('')).status).toBe(400)
    expect((await loyihaSora('   ')).status).toBe(400)
    expect((await loyihaSora(42)).status).toBe(400)
  })

  test('papka nomi hosil bo\'lmasa 400 va yozuv yaratilmaydi', async () => {
    const { status } = await loyihaSora('🚀')
    expect(status).toBe(400)
    expect(loyihalarOqi(db)).toHaveLength(0)
  })

  test('takroriy nom 409 beradi va ikkinchi yozuv yaratilmaydi', async () => {
    expect((await loyihaSora('takror')).status).toBe(201)
    const ikkinchi = await loyihaSora('takror')
    expect(ikkinchi.status).toBe(409)
    expect(loyihalarOqi(db)).toHaveLength(1)
  })

  test('juda uzun nom 400', async () => {
    expect((await loyihaSora('n'.repeat(200))).status).toBe(400)
  })

  test('JSON bo\'lmagan tana 400', async () => {
    const javob = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'buzuq',
    })
    expect(javob.status).toBe(400)
  })
})

describe('GET /api/projects', () => {
  test('bo\'sh ro\'yxat', async () => {
    const javob = await app.request('/api/projects')
    expect(javob.status).toBe(200)
    expect((await javob.json()) as { projects: Project[] }).toEqual({ projects: [] })
  })

  test('har loyiha bilan chatlar soni qaytadi', async () => {
    const bir = loyihaYarat('bir', loyihaPapkasiniYarat('bir'), db)
    loyihaYarat('ikki', loyihaPapkasiniYarat('ikki'), db)
    sessiyaYarat('chat 1', db, bir.id)
    sessiyaYarat('chat 2', db, bir.id)
    // Loyihasiz sessiya hech qaysi loyihaga hisoblanmaydi
    sessiyaYarat('chat 3', db)

    const javob = await app.request('/api/projects')
    const { projects } = (await javob.json()) as { projects: Project[] }

    expect(projects).toHaveLength(2)
    expect(projects.find((p) => p.name === 'bir')?.chatlarSoni).toBe(2)
    expect(projects.find((p) => p.name === 'ikki')?.chatlarSoni).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('repo — loyihalar', () => {
  test('loyihaOqi va loyihaNomBoyicha', () => {
    const l = loyihaYarat('nom', '/tmp/nom', db)
    expect(loyihaOqi(l.id, db)?.name).toBe('nom')
    expect(loyihaNomBoyicha('nom', db)?.id).toBe(l.id)
    expect(loyihaOqi('yoq', db)).toBeNull()
    expect(loyihaNomBoyicha('yoq', db)).toBeNull()
  })

  test('sessiyaLoyihaPapkasi ulangan sessiya uchun papkani beradi', () => {
    const l = loyihaYarat('bog\'langan', '/tmp/boglangan', db)
    const s = sessiyaYarat('chat', db, l.id)
    expect(sessiyaLoyihaPapkasi(s.id, db)).toBe('/tmp/boglangan')
  })

  test('loyihasiz va mavjud bo\'lmagan sessiya uchun null', () => {
    const s = sessiyaYarat('loyihasiz', db)
    expect(sessiyaLoyihaPapkasi(s.id, db)).toBeNull()
    expect(sessiyaLoyihaPapkasi('yoq-sessiya', db)).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/chat/sessions — loyihaga ulanish', () => {
  test('projectId bilan sessiya loyihaga ulanadi', async () => {
    const l = loyihaYarat('chatli', loyihaPapkasiniYarat('chatli'), db)

    const javob = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ulangan', projectId: l.id }),
    })
    expect(javob.status).toBe(201)

    const { session } = (await javob.json()) as { session: ChatSession }
    expect(session.projectId).toBe(l.id)
    // Sessiya ro'yxati va o'qishda ham ko'rinadi
    expect(sessiyaOqi(session.id, db)?.projectId).toBe(l.id)
    expect(sessiyalarOqi(db)[0]?.projectId).toBe(l.id)
  })

  test('projectId siz sessiya loyihasiz qoladi', async () => {
    const javob = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'yolgiz' }),
    })
    const { session } = (await javob.json()) as { session: ChatSession }
    expect(session.projectId).toBeUndefined()
  })

  test('mavjud bo\'lmagan projectId 404 beradi (500 emas)', async () => {
    const javob = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'yomon', projectId: 'yoq-loyiha' }),
    })
    expect(javob.status).toBe(404)
    expect(sessiyalarOqi(db)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('sessiyaIshPapkasi — qaysi papkada ishlaydi', () => {
  test('loyihasiz sessiya o\'z papkasida qoladi', () => {
    const yol = sessiyaIshPapkasi('sessiya-1', null)
    expect(yol).toBe(ishPapkasi('sessiya-1'))
    expect(yol.startsWith(join(vaqtinchalik, 'ishlar'))).toBe(true)
  })

  test('undefined ham loyihasiz deb qaraladi', () => {
    expect(sessiyaIshPapkasi('sessiya-2')).toBe(ishPapkasi('sessiya-2'))
  })

  test('loyihali sessiya loyiha papkasini oladi', () => {
    const loyihaYoli = loyihaPapkasiniYarat('mening-loyiham')
    expect(sessiyaIshPapkasi('sessiya-3', loyihaYoli)).toBe(loyihaYoli)
  })

  test('bir loyihaning ikki sessiyasi BITTA papkani oladi', () => {
    // Konseptning o'zagi: loyiha ichidagi hamma chat bir fayllar to'plamini
    // ko'radi (parallel to'qnashuv qabul qilingan risk)
    const loyihaYoli = loyihaPapkasiniYarat('umumiy')
    expect(sessiyaIshPapkasi('a', loyihaYoli)).toBe(sessiyaIshPapkasi('b', loyihaYoli))
  })

  test('loyiha papkasi o\'chirilgan bo\'lsa qayta yaratiladi', () => {
    const loyihaYoli = loyihaPapkasiniYarat('ochirilgan')
    rmSync(loyihaYoli, { recursive: true, force: true })
    expect(existsSync(loyihaYoli)).toBe(false)

    expect(sessiyaIshPapkasi('sessiya-4', loyihaYoli)).toBe(loyihaYoli)
    expect(existsSync(loyihaYoli)).toBe(true)
  })

  test('ikki xil loyiha ikki xil papka oladi', () => {
    const bir = loyihaPapkasiniYarat('bir')
    const ikki = loyihaPapkasiniYarat('ikki')
    expect(bir).not.toBe(ikki)
  })
})
