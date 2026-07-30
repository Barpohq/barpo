// Migratsiyalar ro'yxati — tartib MUHIM, raqam bo'yicha ketma-ket qo'llanadi.
//
// Yangi migratsiya qo'shish:
//   1) shu papkada `002-nima-qilgani.ts` fayl yarating,
//   2) `export const migratsiya: Migratsiya = { raqam: 2, nom: '...', sql: `...` }`,
//   3) uni pastdagi `migratsiyalar` massiviga qo'shing.
// Qo'llangan migratsiyani HECH QACHON tahrirlamang — yangisini yozing,
// aks holda eski bazalar bilan holat farq qiladi.

export interface Migratsiya {
  raqam: number
  nom: string
  /** Bitta tranzaksiyada bajariladigan SQL (bir nechta statement bo'lishi mumkin) */
  sql: string
  /**
   * SQL o'z `BEGIN`/`COMMIT` ini olib yuradi va tranzaksiyaga
   * O'RALMAYDI.
   *
   * Faqat jadval qayta quradigan migratsiyalar uchun: ular
   * `PRAGMA foreign_keys = OFF` talab qiladi, PRAGMA esa tranzaksiya
   * ichida jimgina e'tiborsiz qoldiriladi (`db.ts` ga q.).
   */
  pragmaTashqarida?: boolean
}

import { migratsiya as m001 } from './001-boshlangich.ts'
import { migratsiya as m002 } from './002-chat-model.ts'
import { migratsiya as m003 } from './003-tool-cards.ts'
import { migratsiya as m004 } from './004-agent-xabarlari.ts'
import { migratsiya as m005 } from './005-loyihalar.ts'
import { migratsiya as m006 } from './006-skilllar.ts'
import { migratsiya as m007 } from './007-serverlar-haqiqiy.ts'
// 8-raqam ATAYLAB tashlab ketilgan — sababi `009-tool-chaqiruvlar.ts` da.
import { migratsiya as m009 } from './009-tool-chaqiruvlar.ts'
import { migratsiya as m010 } from './010-standart-manba.ts'
import { migratsiya as m011 } from './011-mcp-serverlar.ts'

export const migratsiyalar: Migratsiya[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m009,
  m010,
  m011,
]
