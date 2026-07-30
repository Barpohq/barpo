// MCP server kredensiallari — maxfiy sozlama qiymatlari (token, API kalit).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA BAZADA EMAS.                                                    │
// │                                                                      │
// │ SQLite fayli backup qilinadi, ko'chiriladi, ba'zan eksport qilinadi; │
// │ `SELECT * FROM mcp_ornatish` natijasi diagnostika logiga tushishi    │
// │ mumkin. Token bunday yo'llardan chiqib ketmasligi kerak.             │
// │                                                                      │
// │ Shuning uchun `kredensial.ts` dagi `FaylKredensialOmbori` bilan bir  │
// │ xil qaror: alohida fayl, `chmod 600`, faqat platforma jarayoni       │
// │ o'qiy oladi. Bazada esa maxfiy BO'LMAGAN qiymatlar qoladi            │
// │ (`mcp_ornatish.sozlama_qiymatlari`) — masalan `BASE_URL`.            │
// └──────────────────────────────────────────────────────────────────────┘
//
// NEGA `FaylKredensialOmbori` NI QAYTA ISHLATMADIK. U pi-ai ning
// `CredentialStore` interfeysini implement qiladi: provider-markazli
// (`read(providerId)`), `Credential` tipi `oauth`/`api_key` ga bo'linadi va
// `modify` OAuth refresh oqimi uchun mo'ljallangan. MCP'da esa har o'rnatish
// uchun oddiy `Record<string, string>` (env nomi → qiymat) yetarli —
// interfeys mos kelmaydi. Lekin NAQSH aynan takrorlanadi: bitta JSON fayl,
// `navbatda()` serializatsiya zanjiri, `chmod 600`.
//
// KALIT — O'RNATISH ID'SI, server id'si emas. Bitta MCP server bir necha
// joyga o'rnatilishi mumkin (global + bir necha loyiha) va har birining o'z
// tokeni bo'lishi kerak: masalan ikki loyiha bir xil GitHub MCP serverni
// turli repolarga kirish huquqi bor tokenlar bilan ishlatadi.

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Fayldagi ko'rinish: o'rnatish id → { env nomi → qiymat } */
type Fayl = Record<string, Record<string, string>>

/**
 * Kredensial fayli yo'li — `PLATFORMA_MCP_KREDENSIAL` bilan ko'chiriladi.
 *
 * Testlar shu env orqali vaqtinchalik papkaga yo'naltiradi (`PLATFORMA_SKILLS`,
 * `PLATFORMA_SSH` bilan bir xil naqsh) — aks holda test foydalanuvchining
 * haqiqiy kredensial faylini bosib ketardi.
 */
export function mcpKredensialYoli(): string {
  const env = process.env.PLATFORMA_MCP_KREDENSIAL?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'mcp-kredensiallar.json')
}

export interface McpKredensialOmbori {
  /** Bitta o'rnatishning maxfiy qiymatlari. Yo'q bo'lsa bo'sh obyekt. */
  ol(ornatishId: string): Promise<Record<string, string>>
  /**
   * Qiymatlarni saqlaydi.
   *
   * BO'SH QIYMAT — O'CHIRISH BELGISI: foydalanuvchi maxfiy maydonni bo'sh
   * qoldirsa, u yozilmaydi. Sabab: UI maxfiy qiymatni HECH QACHON qaytarib
   * ko'rsatmaydi (bo'sh input ko'rinadi), ya'ni "o'zgartirmadim" holati ham
   * bo'sh satr bo'lib keladi. Bo'sh satrni saqlasak, forma har ochilganda
   * mavjud token o'chib ketardi — shuning uchun `saqla` faqat BERILGAN
   * kalitlarni yangilaydi va bo'shlarini tegmasdan qoldiradi.
   */
  saqla(ornatishId: string, qiymatlar: Record<string, string>): Promise<void>
  ochir(ornatishId: string): Promise<void>
}

export class FaylMcpKredensialOmbori implements McpKredensialOmbori {
  /** Ketma-ket bajarish navbati — saqla/ochir shu zanjirga ulanadi */
  private navbat: Promise<unknown> = Promise.resolve()

  constructor(private yol: string = mcpKredensialYoli()) {}

  async ol(ornatishId: string): Promise<Record<string, string>> {
    const fayl = await this.faylniOqi()
    return fayl[ornatishId] ?? {}
  }

  async saqla(ornatishId: string, qiymatlar: Record<string, string>): Promise<void> {
    await this.navbatda(async () => {
      const fayl = await this.faylniOqi()
      const mavjud = fayl[ornatishId] ?? {}
      for (const [nom, qiymat] of Object.entries(qiymatlar)) {
        // Bo'sh qiymat "o'zgartirmadim" degani (yuqoridagi izohga q.)
        if (!qiymat) continue
        mavjud[nom] = qiymat
      }
      if (Object.keys(mavjud).length === 0) return
      fayl[ornatishId] = mavjud
      await this.faylniYoz(fayl)
    })
  }

  async ochir(ornatishId: string): Promise<void> {
    await this.navbatda(async () => {
      const fayl = await this.faylniOqi()
      if (!(ornatishId in fayl)) return
      delete fayl[ornatishId]
      await this.faylniYoz(fayl)
    })
  }

  /** Amalni navbatga qo'yadi — xato bo'lsa ham zanjir uzilmaydi */
  private navbatda<T>(amal: () => Promise<T>): Promise<T> {
    const natija = this.navbat.then(amal, amal)
    this.navbat = natija.catch(() => undefined)
    return natija
  }

  private async faylniOqi(): Promise<Fayl> {
    try {
      const matn = await Bun.file(this.yol).text()
      const qiymat = JSON.parse(matn) as unknown
      if (typeof qiymat !== 'object' || qiymat === null || Array.isArray(qiymat)) return {}
      return qiymat as Fayl
    } catch {
      // fayl yo'q yoki buzuq — bo'sh ombordan boshlanadi
      return {}
    }
  }

  private async faylniYoz(fayl: Fayl): Promise<void> {
    mkdirSync(dirname(this.yol), { recursive: true })
    await Bun.write(this.yol, JSON.stringify(fayl, null, 2))
    // Tokenlar maxfiy: faqat egasi o'qiy olsin
    try {
      await Bun.$`chmod 600 ${this.yol}`.quiet()
    } catch {
      // chmod ishlamasa (masalan Windows) — kritik emas
    }
  }
}

/** Xotiradagi ombor — testlar uchun */
export class XotiraMcpKredensialOmbori implements McpKredensialOmbori {
  private saqlangan = new Map<string, Record<string, string>>()

  async ol(ornatishId: string): Promise<Record<string, string>> {
    return { ...(this.saqlangan.get(ornatishId) ?? {}) }
  }

  async saqla(ornatishId: string, qiymatlar: Record<string, string>): Promise<void> {
    const mavjud = this.saqlangan.get(ornatishId) ?? {}
    for (const [nom, qiymat] of Object.entries(qiymatlar)) {
      if (!qiymat) continue
      mavjud[nom] = qiymat
    }
    if (Object.keys(mavjud).length > 0) this.saqlangan.set(ornatishId, mavjud)
  }

  async ochir(ornatishId: string): Promise<void> {
    this.saqlangan.delete(ornatishId)
  }
}

/**
 * Global ombor — `db()` naqshi bilan bir xil: bitta instansiya, testlarda
 * `mcpKredensialOmboriniOrnat()` bilan almashtiriladi.
 */
let ombor: McpKredensialOmbori | null = null

export function mcpKredensialOmbori(): McpKredensialOmbori {
  if (!ombor) ombor = new FaylMcpKredensialOmbori()
  return ombor
}

/** Testlar uchun: omborni almashtirish (`null` — standartga qaytarish) */
export function mcpKredensialOmboriniOrnat(yangi: McpKredensialOmbori | null): void {
  ombor = yangi
}
