// Config fayllarini topish, o'qish va birlashtirish.
//
// Ikki qatlam, pastdan yuqoriga (yuqoridagisi bosadi):
//   1) global   — ~/.platforma/config.json
//   2) loyiha   — <ish papkasi>/.platforma/config.json
//
// Nega ikkitasi? Global — foydalanuvchining odatiy sozlamalari (qaysi model,
// qaysi rejim). Loyiha — shu ish uchun cheklov ("bu papkada faqat o'qish
// tool'lari"). Loyiha fayli global sozlamani pasaytirishi tabiiy, ko'tarishi
// esa — yo'q, chunki loyiha fayli repo bilan birga keladi va unga ishonch
// darajasi pastroq (pi'ning "project trust" muammosi bilan bir xil sabab).
//
// SHUNING UCHUN: `qoshimchaTaqiqlar` birlashadi, boshqa maydonlar esa
// loyiha fayli faqat CHEKLASHI mumkin — buni `chekloviniQoll` bajaradi.
//
// Fayl o'qish HECH QACHON xato tashlamaydi: fayl yo'q, buzuq JSON yoki
// ruxsat yo'q bo'lsa ogohlantirish beriladi va standart qiymatlar ishlaydi.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configlarniBirlashtir, configniTekshir, type ConfigOgohlantirish, type TekshiruvNatijasi } from './tekshir.ts'
import type { Config, QismanConfig } from './sxema.ts'

/** Config fayli nomi — global va loyihada bir xil */
export const CONFIG_FAYLI = 'config.json'

/** Loyiha ichidagi config papkasi */
export const LOYIHA_PAPKASI = '.platforma'

export interface OqishSozlamalari {
  /** Loyiha configi qidiriladigan papka. Berilmasa faqat global o'qiladi. */
  ishPapkasi?: string
  /** Global config papkasi (testlarda almashtiriladi) */
  globalPapka?: string
}

export interface ConfigNatijasi extends TekshiruvNatijasi {
  /** Haqiqatan o'qilgan fayllar — diagnostika va UI uchun */
  oqilganFayllar: string[]
}

/** Global config papkasi: `~/.platforma/` */
export function globalConfigPapkasi(): string {
  const env = process.env.PLATFORMA_CONFIG_PAPKA?.trim()
  if (env) return env
  return join(homedir(), '.platforma')
}

/**
 * Bitta JSON faylni o'qiydi.
 *
 * Uch holat farqlanadi:
 *   - fayl yo'q      → `undefined`, ogohlantirishsiz (bu normal holat)
 *   - buzuq JSON     → `undefined` + ogohlantirish
 *   - o'qildi        → obyekt
 */
export function faylniOqi(
  yol: string,
  ogohlantirishlar: ConfigOgohlantirish[],
): QismanConfig | undefined {
  let xom: string
  try {
    xom = readFileSync(yol, 'utf8')
  } catch (xato) {
    // ENOENT — fayl yo'q, bu kutilgan holat va ogohlantirish talab qilmaydi.
    // Qolgan xatolar (ruxsat yo'q, papka o'rniga fayl) esa aytilishi kerak.
    const kod = (xato as NodeJS.ErrnoException)?.code
    if (kod !== 'ENOENT') {
      ogohlantirishlar.push({ yol, sabab: `o'qib bo'lmadi: ${xatoMatni(xato)}` })
    }
    return undefined
  }

  try {
    const tahlil = JSON.parse(xom) as unknown
    if (typeof tahlil !== 'object' || tahlil === null || Array.isArray(tahlil)) {
      ogohlantirishlar.push({ yol, sabab: 'fayl ichida JSON obyekt kutilgan edi' })
      return undefined
    }
    return tahlil as QismanConfig
  } catch (xato) {
    ogohlantirishlar.push({ yol, sabab: `JSON buzuq: ${xatoMatni(xato)}` })
    return undefined
  }
}

/**
 * Loyiha configining ta'sirini cheklaydi.
 *
 * Loyiha fayli repo bilan birga keladi — ya'ni uni platformaga begona odam
 * yozgan bo'lishi mumkin. Shuning uchun u xavfsizlik chegarasini PASAYTIRA
 * olmaydi:
 *   - `ruxsat.rejim` ni `auto` ga ko'tara olmaydi (faqat `tasdiq` ga tushira)
 *   - `qoshimchaTaqiqlar` ni olib tashlay olmaydi — faqat qo'sha oladi
 *   - `toollar.yoqilgan` ni kengaytira olmaydi — faqat toraytira oladi
 *
 * Qolgan maydonlar (kontekst hajmi, timeout) xavfsizlikka tegishli emas,
 * ular erkin bosadi.
 */
export function loyihaChekloviniQoll(global: Config, loyiha: QismanConfig): QismanConfig {
  const natija: QismanConfig = JSON.parse(JSON.stringify(loyiha)) as QismanConfig

  // Rejimni ko'tarib bo'lmaydi
  if (natija.ruxsat?.rejim === 'auto' && global.ruxsat.rejim !== 'auto') {
    delete natija.ruxsat.rejim
  }

  // Taqiqlar qo'shiladi, almashtirilmaydi
  if (natija.ruxsat?.qoshimchaTaqiqlar) {
    natija.ruxsat.qoshimchaTaqiqlar = [
      ...new Set([...global.ruxsat.qoshimchaTaqiqlar, ...natija.ruxsat.qoshimchaTaqiqlar]),
    ]
  }

  // Tool ro'yxati faqat toraya oladi
  if (natija.agent?.toollar?.yoqilgan) {
    const ruxsatEtilgan = new Set(global.agent.toollar.yoqilgan)
    natija.agent.toollar.yoqilgan = natija.agent.toollar.yoqilgan.filter((t) =>
      ruxsatEtilgan.has(t),
    )
  }

  return natija
}

/**
 * To'liq configni o'qiydi: global + loyiha, tekshirilgan va to'ldirilgan.
 *
 * Xato tashlamaydi — har qanday muammo `ogohlantirishlar` ga tushadi va
 * standart qiymatlar bilan davom etiladi.
 */
export function configniOqi(sozlama?: OqishSozlamalari): ConfigNatijasi {
  const ogohlantirishlar: ConfigOgohlantirish[] = []
  const oqilganFayllar: string[] = []

  const globalYoli = join(sozlama?.globalPapka ?? globalConfigPapkasi(), CONFIG_FAYLI)
  const globalXom = faylniOqi(globalYoli, ogohlantirishlar)
  if (globalXom) oqilganFayllar.push(globalYoli)

  // Global qismini avval to'liq tekshiramiz — loyiha cheklovi tekshirilgan
  // qiymatlarga nisbatan hisoblanishi kerak (masalan `toollar.yoqilgan`
  // standart ro'yxatga nisbatan toraysin, bo'sh ro'yxatga emas)
  const globalNatija = configniTekshir(globalXom ?? {})
  ogohlantirishlar.push(...globalNatija.ogohlantirishlar.map((o) => yolniBelgila(o, globalYoli)))

  if (!sozlama?.ishPapkasi) {
    return { config: globalNatija.config, ogohlantirishlar, oqilganFayllar }
  }

  const loyihaYoli = join(sozlama.ishPapkasi, LOYIHA_PAPKASI, CONFIG_FAYLI)
  const loyihaXom = faylniOqi(loyihaYoli, ogohlantirishlar)
  if (!loyihaXom) {
    return { config: globalNatija.config, ogohlantirishlar, oqilganFayllar }
  }
  oqilganFayllar.push(loyihaYoli)

  const cheklangan = loyihaChekloviniQoll(globalNatija.config, loyihaXom)
  const birlashgan = configlarniBirlashtir(globalXom ?? {}, cheklangan)
  const yakuniy = configniTekshir(birlashgan)

  // Global bosqichda aytilgan ogohlantirishlar takrorlanmasin
  const korilgan = new Set(globalNatija.ogohlantirishlar.map((o) => `${o.yol}|${o.sabab}`))
  ogohlantirishlar.push(
    ...yakuniy.ogohlantirishlar
      .filter((o) => !korilgan.has(`${o.yol}|${o.sabab}`))
      .map((o) => yolniBelgila(o, loyihaYoli)),
  )

  return { config: yakuniy.config, ogohlantirishlar, oqilganFayllar }
}

/** Ogohlantirishga qaysi fayldan kelganini qo'shadi */
function yolniBelgila(o: ConfigOgohlantirish, fayl: string): ConfigOgohlantirish {
  return { yol: o.yol, sabab: `${o.sabab} (${fayl})` }
}

function xatoMatni(xato: unknown): string {
  return xato instanceof Error ? xato.message : String(xato)
}

// ---------------------------------------------------------------------------
// Kesh
// ---------------------------------------------------------------------------
//
// Config har chat so'rovida o'qilmasin — fayl kamdan-kam o'zgaradi.
// Web UI orqali yozilganda `configniYangila()` chaqiriladi.

let _kesh: ConfigNatijasi | null = null
let _keshKaliti = ''

/**
 * Keshlangan config. Birinchi chaqiruvda fayldan o'qiydi.
 * Ish papkasi o'zgarsa qayta o'qiydi (har loyihaning o'z configi bor).
 */
export function config(sozlama?: OqishSozlamalari): ConfigNatijasi {
  const kalit = `${sozlama?.globalPapka ?? ''}|${sozlama?.ishPapkasi ?? ''}`
  if (_kesh && _keshKaliti === kalit) return _kesh
  _kesh = configniOqi(sozlama)
  _keshKaliti = kalit
  return _kesh
}

/** Keshni tozalaydi — fayl o'zgargandan keyin yoki testlarda */
export function configniYangila(): void {
  _kesh = null
  _keshKaliti = ''
}
