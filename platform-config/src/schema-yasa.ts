// `MAYDONLAR` dan JSON Schema quradi.
//
// Nima uchun kerak:
//   1) tahrirlagichlar (VS Code) `$schema` orqali avtomatik to'ldirish va
//      xato belgilashni beradi — foydalanuvchi config yozishda adashmaydi;
//   2) keyinchalik web UI shu sxemadan formani avtomatik quradi — maydon
//      qo'shilsa forma o'zi yangilanadi, alohida UI kodi yozilmaydi.
//
// Sxema qo'lda yozilmaydi, har doim `MAYDONLAR` dan generatsiya qilinadi:
// ikkalasi qo'lda sinxronlansa muqarrar bir-biriga mos kelmay qoladi.

import { MAYDONLAR, type MaydonTarifi } from './sxema.ts'

/** JSON Schema tugunining minimal shakli — bizga kerakli qismi */
interface SxemaTuguni {
  type?: string | string[]
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  enum?: readonly string[]
  items?: SxemaTuguni
  properties?: Record<string, SxemaTuguni>
  additionalProperties?: boolean
}

/** Bitta maydon ta'rifini JSON Schema tuguniga aylantiradi */
function maydonTuguni(tarif: MaydonTarifi): SxemaTuguni {
  const tugun: SxemaTuguni = {
    description: tarif.izoh,
    default: tarif.standart,
  }

  switch (tarif.tur) {
    case 'son':
      tugun.type = 'number'
      if (tarif.eng?.kam !== undefined) tugun.minimum = tarif.eng.kam
      if (tarif.eng?.kop !== undefined) tugun.maximum = tarif.eng.kop
      break
    case 'mantiq':
      tugun.type = 'boolean'
      break
    case 'matn':
      tugun.type = 'string'
      break
    case 'tanlov':
      tugun.type = 'string'
      tugun.enum = tarif.variantlar
      break
    case 'matnRoyxati':
      tugun.type = 'array'
      tugun.items = { type: 'string' }
      break
  }

  // `null` ruxsat etilgan maydonlar ikki turli bo'ladi
  if (tarif.nullBolishiMumkin && typeof tugun.type === 'string') {
    tugun.type = [tugun.type, 'null']
  }

  return tugun
}

/**
 * To'liq JSON Schema quradi.
 *
 * `additionalProperties: false` ataylab: imlo xatosi (`yoqilagan`) darhol
 * tahrirlagichda ko'rinsin, jimgina e'tiborsiz qolmasin.
 */
export function schemaYasa(): Record<string, unknown> {
  const ildiz: SxemaTuguni = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }

  for (const tarif of MAYDONLAR) {
    const qismlar = tarif.yol.split('.')
    let joriy = ildiz

    // Oraliq obyektlarni yaratamiz: agent → siqish → yoqilgan
    for (const qism of qismlar.slice(0, -1)) {
      joriy.properties ??= {}
      const mavjud = joriy.properties[qism]
      if (mavjud) {
        joriy = mavjud
        continue
      }
      const yangi: SxemaTuguni = { type: 'object', properties: {}, additionalProperties: false }
      joriy.properties[qism] = yangi
      joriy = yangi
    }

    joriy.properties ??= {}
    joriy.properties[qismlar.at(-1)!] = maydonTuguni(tarif)
  }

  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    title: 'Platform settings',
    description:
      'Settings for the platform AI agent, its tools and the permission system. ' +
      'This file is generated — do not edit it by hand, ' +
      'change platform-config/src/sxema.ts instead.',
    // `$schema` config faylida ham yoziladi — uni notanish maydon deb
    // hisoblamaslik uchun ruxsat beramiz
    properties: { $schema: { type: 'string' }, ...(ildiz.properties ?? {}) },
    type: 'object',
    additionalProperties: false,
  }
}
