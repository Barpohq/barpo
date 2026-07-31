// Ruxsat QAROR MANBASI yozib olinadimi.
//
// "Bu buyruq nega bajarildi?" — foydalanuvchining eng muhim savoli, va
// ilgari unga javob hech qayerda saqlanmasdi: `sora()` faqat
// `'allow' | 'deny'` qaytarardi, ya'ni auto rejim ruxsat berdimi,
// foydalanuvchi bosdimi yoki "har doim" naqshi ishladimi — hammasi bir xil
// ko'rinardi. Bu test har yo'l uchun manba yozilishini majburlaydi.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { PermissionDecision } from '@platforma/shared'
import { PermissionManager } from '../src/permission.ts'

function sorash(naqsh = 'bash:ls') {
  return {
    tur: 'buyruq' as const,
    amal: 'bash',
    nishon: 'ls',
    sabab: 'sinov',
    naqsh,
  }
}

let boshqaruv: PermissionManager
let qarorlar: PermissionDecision[]

beforeEach(() => {
  boshqaruv = new PermissionManager('sinov-sessiya')
  qarorlar = []
  boshqaruv.ruxsatQarorlariniKuzat((q) => qarorlar.push(q))
})

describe('ruxsat qarori manbasi', () => {
  test("foydalanuvchi ruxsat berdi — manba 'foydalanuvchi'", async () => {
    const kutilmoqda = boshqaruv.sora(sorash())
    const sorov = boshqaruv.kutayotganSorovlar[0]!
    boshqaruv.javobBer(sorov.id, 'allow')

    expect(await kutilmoqda).toBe('allow')
    expect(qarorlar).toHaveLength(1)
    expect(qarorlar[0]).toMatchObject({
      sorovId: sorov.id,
      manba: 'foydalanuvchi',
      berildi: true,
      naqsh: 'bash:ls',
    })
    expect(qarorlar[0]!.vaqt).toBeString()
  })

  test('"har doim" ikki xil manba beradi: bosilgani va keyingi ishlashi', async () => {
    const birinchi = boshqaruv.sora(sorash())
    boshqaruv.javobBer(boshqaruv.kutayotganSorovlar[0]!.id, 'always')
    expect(await birinchi).toBe('allow')
    expect(qarorlar[0]).toMatchObject({ manba: 'foydalanuvchi-hardoim', berildi: true })

    // Ikkinchi marta so'ralmaydi — lekin qaror baribir yozilishi kerak,
    // aks holda bajarilgan amal izsiz qolardi
    expect(await boshqaruv.sora(sorash())).toBe('allow')
    expect(qarorlar).toHaveLength(2)
    expect(qarorlar[1]).toMatchObject({ manba: 'always', berildi: true, naqsh: 'bash:ls' })
    expect(qarorlar[1]!.sorovId).toBeUndefined()
  })

  test("rad etish yozib olinadi", async () => {
    const kutilmoqda = boshqaruv.sora(sorash())
    boshqaruv.javobBer(boshqaruv.kutayotganSorovlar[0]!.id, 'deny')

    expect(await kutilmoqda).toBe('deny')
    expect(qarorlar[0]).toMatchObject({ manba: 'deny', berildi: false })
  })

  test("muddat tugashi ham qaror — jimgina yo'qolmaydi", async () => {
    boshqaruv.kutishMuddatiniOrnat(10)
    expect(await boshqaruv.sora(sorash())).toBe('deny')
    expect(qarorlar[0]).toMatchObject({ manba: 'muddat', berildi: false })
  })

  test("sessiya yopilganda kutayotgan so'rov yozib olinadi", async () => {
    const kutilmoqda = boshqaruv.sora(sorash())
    boshqaruv.close()

    expect(await kutilmoqda).toBe('deny')
    // `bekor`, `rad` EMAS: sessiya tashqaridan yopilgan (reestr TTL,
    // jarayon to'xtashi) — foydalanuvchi bu amalni rad etmagan. Buni
    // "siz rad etdingiz" deb yozish qilinmagan ishni unga yopishtirardi.
    expect(qarorlar[0]).toMatchObject({ manba: 'bekor', berildi: false })
  })

  test("oqim bekor qilinsa so'rov DARHOL yopiladi", async () => {
    // ┌──────────────────────────────────────────────────────────────────┐
    // │ Bu testning sababi og'ir. Ilgari `sora()` bekor qilishni umuman  │
    // │ ko'rmasdi: "To'xtatish" bosilgan oqim shu yerda 5 DAQIQA osilib  │
    // │ turardi. O'sha vaqt ichida:                                      │
    // │   - eski oqimning kartasi UI'da tirik qolib, bosilsa            │
    // │     foydalanuvchi TO'XTATGAN buyruq bajarilardi;                 │
    // │   - muddat tugagach qaror YANGI oqimning tool kartasiga yozilib, │
    // │     "kim ruxsat berdi" izi yolg'on bo'lardi.                     │
    // └──────────────────────────────────────────────────────────────────┘
    const boshqaruvchi = new AbortController()
    const qaytar: PermissionDecision[] = []
    const b = new PermissionManager('bekor-sessiya')
    b.ruxsatQarorlariniKuzat((q) => qaytar.push(q))
    // Signal klassifikator konteksti orqali keladi (agent.ts shunday beradi)
    b.klassifikatorniUla({
      rejim: { rejim: 'tasdiq' } as never,
      suhbat: [],
      workDir: '/tmp',
      signal: boshqaruvchi.signal,
    })

    const kutilmoqda = b.sora(sorash('bash:ssh'))
    expect(b.kutayotganSorovlar).toHaveLength(1)

    boshqaruvchi.abort()

    expect(await kutilmoqda).toBe('deny')
    // So'rov ro'yxatdan chiqdi — UI uni qayta tiklab ko'rsatmaydi
    expect(b.kutayotganSorovlar).toHaveLength(0)
    // `bekor`, `rad` EMAS: foydalanuvchi bu amalni rad etmagan
    expect(qaytar).toHaveLength(1)
    expect(qaytar[0]).toMatchObject({ manba: 'bekor', berildi: false })
  })

  test('allaqachon bekor qilingan oqimda so\'rov umuman ro\'yxatga tushmaydi', async () => {
    const boshqaruvchi = new AbortController()
    boshqaruvchi.abort()
    const b = new PermissionManager('bekor-2')
    const qaytar: PermissionDecision[] = []
    b.ruxsatQarorlariniKuzat((q) => qaytar.push(q))
    b.klassifikatorniUla({
      rejim: { rejim: 'tasdiq' } as never,
      suhbat: [],
      workDir: '/tmp',
      signal: boshqaruvchi.signal,
    })

    expect(await b.sora(sorash())).toBe('deny')
    expect(b.kutayotganSorovlar).toHaveLength(0)
    expect(qaytar[0]?.manba).toBe('bekor')
  })

  test('javob berilgan so\'rov keyin bekor qilinsa IKKINCHI qaror yozilmaydi', async () => {
    const boshqaruvchi = new AbortController()
    const b = new PermissionManager('bekor-3')
    const qaytar: PermissionDecision[] = []
    b.ruxsatQarorlariniKuzat((q) => qaytar.push(q))
    b.klassifikatorniUla({
      rejim: { rejim: 'tasdiq' } as never,
      suhbat: [],
      workDir: '/tmp',
      signal: boshqaruvchi.signal,
    })

    const kutilmoqda = b.sora(sorash())
    b.javobBer(b.kutayotganSorovlar[0]!.id, 'allow')
    expect(await kutilmoqda).toBe('allow')

    boshqaruvchi.abort()
    // Bitta so'rov — bitta qaror. Aks holda bazadagi to'g'ri yozuv
    // "bekor" bilan ustiga yozilardi.
    expect(qaytar).toHaveLength(1)
    expect(qaytar[0]?.manba).toBe('foydalanuvchi')
  })

  test("qat'iy taqiq alohida manba bilan yoziladi", () => {
    boshqaruv.taqiqlanganiniYoz('rm -rf /')
    expect(qarorlar[0]).toMatchObject({
      manba: 'taqiqlangan',
      berildi: false,
      naqsh: 'rm -rf /',
    })
  })

  test("kuzatuvchi xatosi ruxsat oqimini buzmaydi", async () => {
    boshqaruv.ruxsatQarorlariniKuzat(() => {
      throw new Error('kuzatuvchi yiqildi')
    })
    const kutilmoqda = boshqaruv.sora(sorash())
    boshqaruv.javobBer(boshqaruv.kutayotganSorovlar[0]!.id, 'allow')
    expect(await kutilmoqda).toBe('allow')
  })
})
