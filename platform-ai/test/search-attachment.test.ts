// `.barpo` papkasi qidiruvdan chiqarilganini tekshiradi.
//
// NEGA MUHIM. Loyihaga ulangan suhbatlar bitta ish papkasini bo'lishadi
// (`ish-papkasi.ts`), biriktirmalar esa `.barpo/sessiyalar/<sid>/fayllar/`
// da yashaydi. Papka qidiruvdan chiqarilmasa, agent `grep` qilganda BOSHQA
// suhbatlarning fayllaridan result chiqardi — suhbatlar orasida ma'lumot
// sizishi.
//
// Ikkinchi shart ham xuddi shunday muhim: ANIQ YO'L berilsa fayl baribir
// ko'rinishi kerak. Biriktirma oqimi shunga tayanadi — agent promptdagi
// yo'lni `read` ga beradi va o'qishi shart.
//
// Test HAQIQIY fayl tizimida ishlaydi (vaqtinchalik papkada): filtr
// `SKIPPED_DIRS` ro'yxatida ham, ikkala backendda ham
// (`rg` va Node zaxirasi) qo'llanishi kerak, ya'ni soxta fayl tizimi bu
// himoyani tekshirmagan bo'lardi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RestrictedEnv } from '../src/environment.ts'
import { SKIPPED_DIRS } from '../src/search-core.ts'
import { searchToolsRaw } from '../src/search-tools.ts'
import { PermissionManager } from '../src/permission.ts'

let papka: string
let context: { env: RestrictedEnv }

/** Begona sessiyaning biriktirma papkasi */
const BEGONA_YOL = '.barpo/sessiyalar/boshqa-sid/fayllar'

beforeEach(() => {
  papka = mkdtempSync(join(tmpdir(), 'barpo-qidiruv-biriktirma-'))

  // Oddiy code fayli — topilishi KERAK
  writeFileSync(join(papka, 'code.ts'), 'const BELGI = "code ichida"\n')

  // Begona sessiyaning biriktirmasi — topilmasligi kerak
  mkdirSync(join(papka, BEGONA_YOL), { recursive: true })
  writeFileSync(join(papka, BEGONA_YOL, 'begona.txt'), 'const BELGI = "begona suhbatdan"\n')

  // Skill va xotira ham shu papkada — ular ham chiqadi (ongli almashtirish)
  mkdirSync(join(papka, '.barpo/memory'), { recursive: true })
  writeFileSync(join(papka, '.barpo/memory/eslatma.md'), 'const BELGI = "xotirada"\n')

  // Ruxsat so'ralishi bu testlarda KUTILMAYDI: hamma yo'l ish papkasi
  // ichida. So'rov kelsa u javobsiz qoladi va test timeout bilan yiqiladi —
  // bu to'g'ri xulq, chunki limit buzilganini bildiradi.
  context = {
    env: new RestrictedEnv({
      workDir: papka,
      permission: new PermissionManager('sinov'),
    }),
  }
})

afterEach(() => {
  rmSync(papka, { recursive: true, force: true })
})

/** Tool natijasidagi text */
async function bajar(name: string, args: unknown): Promise<string> {
  const tool = searchToolsRaw().find((t) => t.name === name)
  if (!tool) throw new Error(`tool topilmadi: ${name}`)
  const result = await (
    tool.execute as unknown as (
      id: string,
      p: unknown,
      s: undefined,
      u: undefined,
      k: unknown,
    ) => Promise<{ content: { type: string; text?: string }[] }>
  )('t1', args, undefined, undefined, context)
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
}

describe('`.barpo` qidiruvdan chiqarilgan', () => {
  test('ro\'yxatda bor — ikkala backend shu ro\'yxatdan o\'qiydi', () => {
    expect(SKIPPED_DIRS).toContain('.barpo')
  })

  test('grep begona sessiyaning biriktirmasini TOPMAYDI', async () => {
    const result = await bajar('grep', { pattern: 'BELGI' })

    expect(result).toContain('code.ts')
    expect(result).not.toContain('begona.txt')
  })

  test('find begona biriktirmani ko\'rsatmaydi', async () => {
    const result = await bajar('find', { pattern: '*.txt' })

    expect(result).not.toContain('begona.txt')
  })

  test('ls ildizda `.barpo` ni ko\'rsatmaydi', async () => {
    const result = await bajar('ls', {})

    expect(result).toContain('code.ts')
    expect(result).not.toContain('.barpo')
  })

  // ONGLI YON TA'SIR: xotira va skilllar ham qidiruvdan chiqadi. Ular
  // promptga baribir to'liq tushadi (`xotira.ts`, `skill-yuklash.ts`), ya'ni
  // agent ularni ko'radi — faqat `grep` bilan izlay olmaydi. Bu test o'zgarish
  // ONGLI ekanini yozib qo'yadi: kimdir buni "xato" deb tuzatmoqchi bo'lsa,
  // yuqoridagi izohni o'qishi kerak.
  test('xotira fayllari ham qidiruvdan chiqadi (ongli almashtirish)', async () => {
    const result = await bajar('grep', { pattern: 'BELGI' })

    expect(result).not.toContain('eslatma.md')
  })
})

describe('aniq yo\'l bilan o\'qish ishlaydi', () => {
  // BIRIKTIRMA OQIMI SHUNGA TAYANADI: agent promptdagi yo'lni `read` ga
  // beradi. Ro'yxat faqat AYLANIB CHIQISHNI to'sadi, aniq so'rovni emas.
  test('ls aniq yo\'l bilan biriktirmalarni ko\'rsatadi', async () => {
    const result = await bajar('ls', { path: BEGONA_YOL })

    expect(result).toContain('begona.txt')
  })

  test('grep aniq papkada izlaydi', async () => {
    const result = await bajar('grep', { pattern: 'BELGI', path: BEGONA_YOL })

    expect(result).toContain('begona.txt')
  })
})
