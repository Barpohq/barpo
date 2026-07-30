// Config qiymatlarini tekshirish va standart qiymatlar bilan to'ldirish.
//
// ASOSIY QOIDA: tekshiruv HECH QACHON xato tashlamaydi va konfig o'qishni
// to'xtatmaydi. Noto'g'ri maydon standart qiymatga qaytariladi, sabab esa
// ogohlantirishlar ro'yxatiga tushadi.
//
// Nega shunday? Config foydalanuvchi qo'li bilan tahrirlanadigan fayl.
// Bitta xato maydon butun platformani ishga tushmaydigan qilib qo'ysa, bu
// yomon almashuv — ayniqsa keyinchalik config web orqali yozilganda, yarim
// yozilgan fayl serverni yiqitmasligi kerak.
//
// Xavfsizlikka tegishli maydonlarda esa aksincha: shubhali qiymat standart
// qiymatga QAYTARILADI, "iloji boricha bajaramiz" degan yondashuv yo'q.

import { MAYDONLAR, type Config, type MaydonTarifi, type QismanConfig } from './sxema.ts'

/** Config o'qishda yuzaga kelgan muammo — ishni to'xtatmaydi */
export interface ConfigOgohlantirish {
  /** Qaysi maydon (nuqtali yo'l), umumiy muammo bo'lsa fayl yo'li */
  yol: string
  sabab: string
}

export interface TekshiruvNatijasi {
  config: Config
  ogohlantirishlar: ConfigOgohlantirish[]
}

// ---------------------------------------------------------------------------
// Nuqtali yo'l bilan ishlash
// ---------------------------------------------------------------------------

/** `agent.siqish.yoqilgan` bo'yicha qiymatni oladi */
export function yoldanOqi(manba: unknown, yol: string): unknown {
  let joriy: unknown = manba
  for (const qism of yol.split('.')) {
    if (typeof joriy !== 'object' || joriy === null) return undefined
    joriy = (joriy as Record<string, unknown>)[qism]
  }
  return joriy
}

/** `agent.siqish.yoqilgan` bo'yicha qiymat yozadi, oraliq obyektlarni yaratadi */
export function yolgaYoz(nishon: Record<string, unknown>, yol: string, qiymat: unknown): void {
  const qismlar = yol.split('.')
  let joriy = nishon
  for (let i = 0; i < qismlar.length - 1; i += 1) {
    const qism = qismlar[i]!
    const keyingi = joriy[qism]
    if (typeof keyingi !== 'object' || keyingi === null || Array.isArray(keyingi)) {
      joriy[qism] = {}
    }
    joriy = joriy[qism] as Record<string, unknown>
  }
  joriy[qismlar.at(-1)!] = qiymat
}

// ---------------------------------------------------------------------------
// Bitta maydonni tekshirish
// ---------------------------------------------------------------------------

/**
 * Maydon qiymatini tekshiradi.
 *
 * Qaytadi: qabul qilingan qiymat + (agar almashtirilgan bo'lsa) sabab.
 * Sabab bo'lsa qiymat standartga qaytarilgan degani.
 */
export function maydonniTekshir(
  tarif: MaydonTarifi,
  xom: unknown,
): { qiymat: unknown; sabab?: string } {
  // Ko'rsatilmagan maydon — standart qiymat, bu xato emas
  if (xom === undefined) return { qiymat: standartNusxasi(tarif) }

  if (xom === null) {
    if (tarif.nullBolishiMumkin) return { qiymat: null }
    return { qiymat: standartNusxasi(tarif), sabab: 'null is not allowed' }
  }

  switch (tarif.tur) {
    case 'mantiq':
      if (typeof xom !== 'boolean') {
        return { qiymat: tarif.standart, sabab: `expected a boolean, got ${turNomi(xom)}` }
      }
      return { qiymat: xom }

    case 'son': {
      if (typeof xom !== 'number' || !Number.isFinite(xom)) {
        return { qiymat: tarif.standart, sabab: `expected a number, got ${turNomi(xom)}` }
      }
      // Chegaradan chiqqan qiymat KESILADI, standartga qaytarilmaydi:
      // foydalanuvchi niyati aniq ("juda katta qilmoqchi edim"), shunchaki
      // ruxsat etilgan oraliqqa keltiramiz.
      const kam = tarif.eng?.kam
      const kop = tarif.eng?.kop
      if (kam !== undefined && xom < kam) {
        return { qiymat: kam, sabab: `${xom} is too small, raised to ${kam}` }
      }
      if (kop !== undefined && xom > kop) {
        return { qiymat: kop, sabab: `${xom} is too large, lowered to ${kop}` }
      }
      return { qiymat: xom }
    }

    case 'matn':
      if (typeof xom !== 'string') {
        return { qiymat: tarif.standart, sabab: `expected a string, got ${turNomi(xom)}` }
      }
      return { qiymat: xom }

    case 'tanlov': {
      if (typeof xom !== 'string') {
        return { qiymat: tarif.standart, sabab: `expected a string, got ${turNomi(xom)}` }
      }
      const variantlar = tarif.variantlar ?? []
      if (!variantlar.includes(xom)) {
        return {
          qiymat: tarif.standart,
          sabab: `"${xom}" is not allowed, options: ${variantlar.join(', ')}`,
        }
      }
      return { qiymat: xom }
    }

    case 'matnRoyxati': {
      if (!Array.isArray(xom)) {
        // NUSXA qaytariladi: `MAYDONLAR` dagi standart massiv ulashilgan
        // obyekt, uni to'g'ridan-to'g'ri bersak chaqiruvchi `push` qilganda
        // standart qiymatning o'zi buzilardi — keyingi sessiyalarga o'tib
        // ketadigan, topish qiyin xato.
        return { qiymat: [...(tarif.standart as string[])], sabab: `expected a list, got ${turNomi(xom)}` }
      }
      // Ro'yxat ichidagi noto'g'ri elementlar tashlab yuboriladi, butun
      // ro'yxat emas — foydalanuvchining to'g'ri yozgan qismi saqlanadi
      const tozalangan = xom.filter((e): e is string => typeof e === 'string')
      if (tozalangan.length !== xom.length) {
        return {
          qiymat: tozalangan,
          sabab: `${xom.length - tozalangan.length} non-string item(s) were dropped`,
        }
      }
      return { qiymat: tozalangan }
    }
  }
}

function turNomi(qiymat: unknown): string {
  if (Array.isArray(qiymat)) return "ro'yxat"
  if (qiymat === null) return 'null'
  return typeof qiymat
}

/**
 * Standart qiymatning xavfsiz nusxasi.
 *
 * `MAYDONLAR` — modul darajasidagi doimiy obyekt. Undagi massivni
 * to'g'ridan-to'g'ri qaytarsak, chaqiruvchi uni o'zgartirganda (`push`)
 * standart qiymatning O'ZI buziladi va keyingi barcha sessiyalar buzilgan
 * qiymatni oladi. Primitivlar uchun nusxa kerak emas, lekin bitta joyda
 * hal qilingani xavfsizroq — yangi massivli maydon qo'shilganda unutilmaydi.
 */
function standartNusxasi(tarif: MaydonTarifi): unknown {
  return Array.isArray(tarif.standart) ? [...tarif.standart] : tarif.standart
}

// ---------------------------------------------------------------------------
// To'liq configni tekshirish
// ---------------------------------------------------------------------------

/**
 * Xom obyektdan to'liq, tekshirilgan configni quradi.
 *
 * Kiruvchi obyekt istalgan shaklda bo'lishi mumkin (fayldan kelgan JSON) —
 * faqat `MAYDONLAR` da e'lon qilingan yo'llar o'qiladi, qolgani e'tiborsiz
 * qoldiriladi (lekin notanish maydon ogohlantirish beradi, chunki odatda
 * bu imlo xatosi).
 */
export function configniTekshir(xom: unknown): TekshiruvNatijasi {
  const ogohlantirishlar: ConfigOgohlantirish[] = []
  const natija: Record<string, unknown> = {}

  for (const tarif of MAYDONLAR) {
    const { qiymat, sabab } = maydonniTekshir(tarif, yoldanOqi(xom, tarif.yol))
    yolgaYoz(natija, tarif.yol, qiymat)
    if (sabab) ogohlantirishlar.push({ yol: tarif.yol, sabab })
  }

  for (const notanish of notanishYollar(xom)) {
    ogohlantirishlar.push({ yol: notanish, sabab: 'unknown setting — ignored' })
  }

  return { config: natija as unknown as Config, ogohlantirishlar }
}

/**
 * Configda e'lon qilinmagan yo'llarni topadi.
 *
 * Imlo xatosi jimgina yo'qolmasin: `agent.siqish.yoqilagan` yozgan
 * foydalanuvchi sozlama ishlamayotganini bilishi kerak.
 */
function notanishYollar(xom: unknown): string[] {
  if (typeof xom !== 'object' || xom === null || Array.isArray(xom)) return []

  const malum = new Set<string>(MAYDONLAR.map((m) => m.yol))
  // Oraliq yo'llar ham qonuniy: `agent`, `agent.siqish`
  for (const m of MAYDONLAR) {
    const qismlar = m.yol.split('.')
    for (let i = 1; i < qismlar.length; i += 1) malum.add(qismlar.slice(0, i).join('.'))
  }

  const topilgan: string[] = []
  const yur = (obyekt: Record<string, unknown>, prefiks: string) => {
    for (const [kalit, qiymat] of Object.entries(obyekt)) {
      const yol = prefiks ? `${prefiks}.${kalit}` : kalit
      // `$schema` — tahrirlagichlar uchun, sozlama emas
      if (yol === '$schema') continue
      if (!malum.has(yol)) {
        topilgan.push(yol)
        continue // ichiga kirmaymiz — butun shox notanish
      }
      if (typeof qiymat === 'object' && qiymat !== null && !Array.isArray(qiymat)) {
        yur(qiymat as Record<string, unknown>, yol)
      }
    }
  }
  yur(xom as Record<string, unknown>, '')
  return topilgan
}

/** Standart config — fayl umuman bo'lmaganda ishlatiladi */
export function standartConfig(): Config {
  return configniTekshir({}).config
}

/**
 * Ikki configni birlashtiradi: `ustki` `astki` ni bosadi.
 *
 * Faqat MAVJUD maydonlar bosadi — `undefined` qiymat astki qatlamni
 * o'chirmaydi. Bu global va loyiha configlari uchun muhim: loyiha fayli
 * bitta sozlamani o'zgartirsa, qolganlari globaldan qoladi.
 *
 * Massivlar BUTUNLAY almashtiriladi, qo'shilmaydi — `toollar.yoqilgan`
 * uchun bu yagona to'g'ri semantika (loyiha "faqat read va grep" desa,
 * globaldagi `bash` qo'shilib qolmasligi kerak).
 */
export function configlarniBirlashtir(astki: QismanConfig, ustki: QismanConfig): QismanConfig {
  const natija: Record<string, unknown> = {}
  for (const manba of [astki, ustki]) {
    for (const [bolim, qiymatlar] of Object.entries(manba)) {
      if (typeof qiymatlar !== 'object' || qiymatlar === null) continue
      const mavjud = (natija[bolim] as Record<string, unknown> | undefined) ?? {}
      for (const [kalit, qiymat] of Object.entries(qiymatlar)) {
        if (qiymat === undefined) continue
        mavjud[kalit] = qiymat
      }
      natija[bolim] = mavjud
    }
  }
  return natija as QismanConfig
}
