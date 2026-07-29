// Tool chaqiruvlari BAZAGA UI'dan OLDIN yoziladimi.
//
// Bu test uchta aniq xatoni qo'riqlaydi:
//   1) chaqiruv WS'ga ketib, bazaga tushmasligi — oqim uzilsa bajarilgan
//      buyruq izsiz yo'qolardi;
//   2) ruxsat qarori (kim ruxsat berdi) saqlanmasligi;
//   3) uzilgan javobning kartalari tarixda ko'rinmasligi — ular faqat
//      `chat_messages.tool_cards` da, oqim OXIRIDA yozilardi.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@platforma/shared'

let soxtaHodisalar: unknown[] = []

const haqiqiyAi = await import('@platforma/ai')

mock.module('@platforma/ai', () => ({
  ...haqiqiyAi,
  suhbatOqimi: async function* () {
    for (const h of soxtaHodisalar) yield h
  },
  agentOqimi: async function* () {
    for (const h of soxtaHodisalar) yield h
  },
}))

const { bazaOch, dbOrnat } = await import('../src/db.ts')
const { javobOqizi } = await import('../src/orchestrator.ts')
const { sessiyaYarat, toolChaqiruvlarOqi, xabarlarOqi } = await import('../src/repo.ts')
const { hub } = await import('../src/ws/hub.ts')

let db: Database
let olingan: ServerEvent[]
let ishlarPapkasi: string

const tanlov = { provider: 'ollama', model: 'qwen3:0.6b' }

beforeEach(() => {
  ishlarPapkasi = mkdtempSync(join(tmpdir(), 'tool-chaqiruv-'))
  process.env.PLATFORMA_ISHLAR = ishlarPapkasi
  db = bazaOch(':memory:')
  dbOrnat(db)
  olingan = []
  hub.ulandi({
    data: { id: 'soxta', channels: new Set(['chat', 'audit']) },
    send: (m: string) => olingan.push(JSON.parse(m) as ServerEvent),
  } as never)
  olingan.length = 0
  soxtaHodisalar = []
})

afterEach(() => {
  delete process.env.PLATFORMA_ISHLAR
  rmSync(ishlarPapkasi, { recursive: true, force: true })
  dbOrnat(null)
  hub.tozala()
  db.close()
})

describe('tool chaqiruvlari bazaga yoziladi', () => {
  test('har bosqich yozib boriladi — boshlanishi ham, tugashi ham', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'ls -la' },
      { tur: 'tool_tugadi', id: 't1', natija: 'fayllar', xatomi: false },
      { tur: 'tugadi', matn: 'tayyor', sarflov: { input: 1, output: 1, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-1', tanlov)

    const chaqiruvlar = toolChaqiruvlarOqi('x-1', db)
    expect(chaqiruvlar).toHaveLength(1)
    expect(chaqiruvlar[0]).toMatchObject({
      id: 't1',
      nom: 'bash',
      args: 'ls -la',
      holat: 'tugadi',
      natija: 'fayllar',
    })
  })

  test('OQIM UZILSA HAM bajarilgan buyruq bazada qoladi', async () => {
    // Xato tool tugagandan KEYIN keladi: ilgari bunday holatda kartalar
    // faqat xabar bilan birga yozilardi, xabar esa yozilmasligi mumkin edi
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'ssh server-107 uptime' },
      { tur: 'tool_tugadi', id: 't1', natija: 'up 3 days', xatomi: false },
      { tur: 'xato', xabar: 'provider uzildi' },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-uzilgan', tanlov)

    const chaqiruvlar = toolChaqiruvlarOqi('x-uzilgan', db)
    expect(chaqiruvlar).toHaveLength(1)
    expect(chaqiruvlar[0]?.args).toBe('ssh server-107 uptime')
    expect(chaqiruvlar[0]?.natija).toBe('up 3 days')
  })

  test('ruxsat qarori chaqiruvga biriktirilib saqlanadi', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'sudo systemctl restart nginx' },
      {
        tur: 'ruxsat_kerak',
        sorov: {
          id: 'r1',
          sessionId: 's',
          tur: 'buyruq',
          amal: 'bash',
          nishon: 'sudo systemctl restart nginx',
          sabab: 'sudo',
          naqsh: 'sudo',
          vaqt: new Date().toISOString(),
        },
      },
      {
        tur: 'ruxsat_qarori',
        qaror: {
          sorovId: 'r1',
          manba: 'foydalanuvchi-hardoim',
          berildi: true,
          naqsh: 'sudo',
          vaqt: new Date().toISOString(),
        },
      },
      { tur: 'tool_tugadi', id: 't1', natija: 'ok', xatomi: false },
      { tur: 'tugadi', matn: 'qayta ishga tushirildi', sarflov: { input: 1, output: 1, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-ruxsat', tanlov)

    const chaqiruv = toolChaqiruvlarOqi('x-ruxsat', db)[0]
    expect(chaqiruv?.ruxsat).toMatchObject({
      sorovId: 'r1',
      manba: 'foydalanuvchi-hardoim',
      berildi: true,
      naqsh: 'sudo',
    })
    // Tugash eventi ruxsatni bilmaydi — u ustiga yozib yubormasligi kerak
    expect(chaqiruv?.holat).toBe('tugadi')
    expect(chaqiruv?.natija).toBe('ok')
  })

  test('auto rejim qarori ham saqlanadi', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'curl -s example.com' },
      {
        tur: 'ruxsat_qarori',
        qaror: { manba: 'auto', berildi: true, naqsh: 'curl', vaqt: new Date().toISOString() },
      },
      { tur: 'klassifikator', qaror: 'ruxsat', izoh: "foydalanuvchi so'raganidan chetga chiqmaydi" },
      { tur: 'tool_tugadi', id: 't1', natija: '<html>', xatomi: false },
      { tur: 'tugadi', matn: 'olindi', sarflov: { input: 1, output: 1, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-auto', tanlov)

    const chaqiruv = toolChaqiruvlarOqi('x-auto', db)[0]
    expect(chaqiruv?.ruxsat?.manba).toBe('auto')
    expect(chaqiruv?.klassifikator?.qaror).toBe('ruxsat')
  })

  test('rad etilgan buyruq sababi bilan saqlanadi', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'rm -rf /' },
      {
        tur: 'ruxsat_qarori',
        qaror: { manba: 'taqiqlangan', berildi: false, naqsh: 'rm', vaqt: new Date().toISOString() },
      },
      { tur: 'tool_tugadi', id: 't1', natija: 'Ruxsat berilmadi: taqiq', xatomi: true },
      { tur: 'tugadi', matn: 'bajarmadim', sarflov: { input: 1, output: 1, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-taqiq', tanlov)

    const chaqiruv = toolChaqiruvlarOqi('x-taqiq', db)[0]
    expect(chaqiruv?.ruxsat).toMatchObject({ manba: 'taqiqlangan', berildi: false })
    expect(chaqiruv?.holat).toBe('rad etildi')
  })

  test('baza yozuvi WS eventidan OLDIN bo\'ladi', async () => {
    // Tartibni bilvosita tekshiramiz: `chat.tool` eventi kelgan paytda
    // yozuv bazada allaqachon turishi kerak.
    const s = sessiyaYarat('sinov', db)
    let bazadaBormi = false

    hub.ulandi({
      data: { id: 'tekshiruvchi', channels: new Set(['chat']) },
      send: (m: string) => {
        const e = JSON.parse(m) as ServerEvent
        if (e.type === 'chat.tool' && !bazadaBormi) {
          bazadaBormi = toolChaqiruvlarOqi('x-tartib', db).length > 0
        }
      },
    } as never)

    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'read', args: 'a.txt' },
      { tur: 'tugadi', matn: 'ok', sarflov: { input: 1, output: 1, cost: 0 } },
    ]
    await javobOqizi(s.id, 'x-tartib', tanlov)

    expect(bazadaBormi).toBe(true)
  })

  test("begona so'rovning qarori HECH QAYSI kartaga yozilmaydi", async () => {
    // Bir sessiyada ikki oqim qisqa vaqt yonma-yon yashashi mumkin
    // (foydalanuvchi to'xtatib, darhol yangi xabar yubordi). Eski oqimning
    // so'rovi bo'yicha qaror kelsa, u YANGI oqimning kartasiga yopishmasligi
    // kerak — aks holda "kim ruxsat berdi" izi yolg'on bo'lardi.
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'read', args: 'config.ts' },
      {
        tur: 'ruxsat_qarori',
        qaror: {
          sorovId: 'boshqa-oqimniki',
          manba: 'muddat',
          berildi: false,
          naqsh: 'rm',
          vaqt: new Date().toISOString(),
        },
      },
      { tur: 'tool_tugadi', id: 't1', natija: 'mazmun', xatomi: false },
      { tur: 'tugadi', matn: 'ok', sarflov: { input: 1, output: 1, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-begona', tanlov)

    const chaqiruv = toolChaqiruvlarOqi('x-begona', db)[0]
    expect(chaqiruv?.nom).toBe('read')
    expect(chaqiruv?.ruxsat).toBeUndefined()
  })

  test("qaror SO'RAGAN chaqiruvga boradi, keyingisiga emas", async () => {
    // Ruxsat javobi kechikadi: u kelganda agent allaqachon boshqa tool'ni
    // bajarayotgan bo'lishi mumkin. Qaror baribir so'ragan kartaga tegishli.
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'ssh server-107 uptime' },
      {
        tur: 'ruxsat_kerak',
        sorov: {
          id: 'r1',
          sessionId: 's',
          tur: 'buyruq',
          amal: 'bash',
          nishon: 'ssh server-107 uptime',
          sabab: 'ssh',
          naqsh: 'ssh',
          vaqt: new Date().toISOString(),
        },
      },
      { tur: 'tool_tugadi', id: 't1', natija: 'up 3 days', xatomi: false },
      // Endi boshqa tool ishlayapti...
      { tur: 'tool_boshlandi', id: 't2', nom: 'read', args: 'a.txt' },
      // ...va endigina birinchisining qarori keldi
      {
        tur: 'ruxsat_qarori',
        qaror: {
          sorovId: 'r1',
          manba: 'foydalanuvchi',
          berildi: true,
          naqsh: 'ssh',
          vaqt: new Date().toISOString(),
        },
      },
      { tur: 'tool_tugadi', id: 't2', natija: 'matn', xatomi: false },
      { tur: 'tugadi', matn: 'ok', sarflov: { input: 1, output: 1, cost: 0 } },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-kechikkan', tanlov)

    const chaqiruvlar = toolChaqiruvlarOqi('x-kechikkan', db)
    const ssh = chaqiruvlar.find((c) => c.id === 't1')
    const oqish = chaqiruvlar.find((c) => c.id === 't2')
    expect(ssh?.ruxsat?.manba).toBe('foydalanuvchi')
    expect(oqish?.ruxsat).toBeUndefined()
  })

  test("xabari yozilmay qolgan chaqiruvlar tarixda YO'QOLMAYDI", async () => {
    // Jarayon oqim o'rtasida to'xtaganda assistant xabari yozilmaydi, tool
    // yozuvlari esa bazada qoladi. Ular yetim bo'lib ko'rinmay ketmasligi
    // kerak — aynan shu ma'lumot yo'qolishi oldini olish uchun jadval bor.
    const s = sessiyaYarat('sinov', db)
    const { toolChaqiruvYoz } = await import('../src/repo.ts')
    toolChaqiruvYoz(
      {
        id: 'yetim-1',
        sessionId: s.id,
        messageId: 'yozilmagan-xabar',
        nom: 'bash',
        args: 'ssh server-107 systemctl restart nginx',
        holat: 'tugadi',
        natija: 'ok',
        ruxsat: {
          manba: 'foydalanuvchi',
          berildi: true,
          naqsh: 'ssh',
          vaqt: new Date().toISOString(),
        },
      },
      db,
    )

    const xabarlar = xabarlarOqi(s.id, db)
    const tiklangan = xabarlar.find((x) => x.id === 'yozilmagan-xabar')
    expect(tiklangan).toBeDefined()
    expect(tiklangan?.role).toBe('assistant')
    expect(tiklangan?.text).toContain('uzilgan')
    expect(tiklangan?.toolCards?.[0]?.args).toBe('ssh server-107 systemctl restart nginx')
    expect(tiklangan?.toolCards?.[0]?.ruxsat?.manba).toBe('foydalanuvchi')
    // Yarim qolgan kontekst keyingi turn'ni yiqitmasligi kerak
    expect(tiklangan?.agentMessages).toBeUndefined()
  })

  test('tarix kartalarni tool jadvalidan oladi (uzilgan javob ham ko\'rinadi)', async () => {
    soxtaHodisalar = [
      { tur: 'tool_boshlandi', id: 't1', nom: 'bash', args: 'ssh server-107 df -h' },
      {
        tur: 'ruxsat_qarori',
        qaror: { manba: 'foydalanuvchi', berildi: true, naqsh: 'ssh', vaqt: new Date().toISOString() },
      },
      { tur: 'tool_tugadi', id: 't1', natija: '/dev/sda1 40%', xatomi: false },
      { tur: 'xato', xabar: 'provider uzildi' },
    ]

    const s = sessiyaYarat('sinov', db)
    await javobOqizi(s.id, 'x-tarix', tanlov)

    const xabarlar = xabarlarOqi(s.id, db)
    const javob = xabarlar.find((x) => x.role === 'assistant')
    expect(javob?.toolCards).toHaveLength(1)
    // Ruxsat qarori faqat tool jadvalida bor — eski `tool_cards` ustunidan
    // kelmaydi, ya'ni bu maydon manba to'g'ri tanlanganini isbotlaydi
    expect(javob?.toolCards?.[0]?.ruxsat?.manba).toBe('foydalanuvchi')
  })
})
