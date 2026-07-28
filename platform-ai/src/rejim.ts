// Ruxsat rejimi va uning fallback mexanizmi.
//
// Ikki rejim:
//   'tasdiq' — har xavfli/notanish amal foydalanuvchidan so'raladi (standart)
//   'auto'   — klassifikator hal qiladi, so'rovlar keskin kamayadi
//
// Auto rejim ATAYLAB O'CHADI uch holatda (Claude Code'ning fallback modeli):
//   1) klassifikator nosoz (model yo'q, timeout, buzuq javob)
//   2) ketma-ket 3 marta blok — agent noto'g'ri yo'ldan ketayotgani belgisi
//   3) sessiya davomida jami 20 marta blok
//
// O'chgach avtomatik tiklanmaydi: foydalanuvchi "Qayta yoqish" bosishi kerak.
// Sabab — rejimning o'z-o'zidan o'zgarishi chalkash, foydalanuvchi qaysi
// rejimda ekanini bilishi kerak.

import type { RuxsatRejimi } from '@platforma/shared'

/** Ketma-ket blok chegarasi */
export const KETMA_KET_BLOK_CHEGARASI = 3
/** Sessiya davomidagi jami blok chegarasi */
export const JAMI_BLOK_CHEGARASI = 20

export interface RejimOzgarishi {
  rejim: RuxsatRejimi
  /** Auto o'chgan bo'lsa — nima uchun */
  sabab?: string
}

export type RejimKuzatuvchi = (ozgarish: RejimOzgarishi) => void

/**
 * Bitta sessiyaning ruxsat rejimi.
 *
 * Hisoblagichlar shu obyekt ichida — sessiya tugasa unutiladi.
 */
export class RejimBoshqaruvchi {
  private _rejim: RuxsatRejimi = 'tasdiq'
  private _sabab: string | undefined
  private ketmaKetBlok = 0
  private jamiBlok = 0
  private kuzatuvchilar = new Set<RejimKuzatuvchi>()

  constructor(readonly sessionId: string) {}

  get rejim(): RuxsatRejimi {
    return this._rejim
  }

  /** Auto o'chgan bo'lsa sababi, aks holda undefined */
  get sabab(): string | undefined {
    return this._sabab
  }

  get holat(): RejimOzgarishi {
    return { rejim: this._rejim, sabab: this._sabab }
  }

  /** Diagnostika uchun */
  get hisoblagichlar(): { ketmaKet: number; jami: number } {
    return { ketmaKet: this.ketmaKetBlok, jami: this.jamiBlok }
  }

  kuzat(kuzatuvchi: RejimKuzatuvchi): () => void {
    this.kuzatuvchilar.add(kuzatuvchi)
    return () => {
      this.kuzatuvchilar.delete(kuzatuvchi)
    }
  }

  /**
   * Foydalanuvchi rejimni o'zgartirdi (yoki "Qayta yoqish" bosdi).
   * Auto ga o'tishda hisoblagichlar nolga qaytadi — yangi imkoniyat beriladi.
   */
  ornat(rejim: RuxsatRejimi): void {
    if (rejim === this._rejim && this._sabab === undefined) return
    this._rejim = rejim
    this._sabab = undefined
    if (rejim === 'auto') {
      this.ketmaKetBlok = 0
      this.jamiBlok = 0
    }
    this.xabarBer()
  }

  /**
   * Klassifikator amalga ruxsat berdi.
   * Ketma-ket hisoblagich nolga qaytadi, jami hisoblagich qoladi
   * (Claude Code'dagi bilan bir xil semantika).
   */
  ruxsatBerildi(): void {
    this.ketmaKetBlok = 0
  }

  /**
   * Klassifikator amalni bloklandi. Chegaraga yetsa auto o'chadi.
   * Rejim o'zgargan bo'lsa `true` qaytaradi.
   */
  blokBoldi(): boolean {
    if (this._rejim !== 'auto') return false

    this.ketmaKetBlok += 1
    this.jamiBlok += 1

    if (this.ketmaKetBlok >= KETMA_KET_BLOK_CHEGARASI) {
      this.autoniOchir(
        `klassifikator ketma-ket ${KETMA_KET_BLOK_CHEGARASI} marta bloklandi — ` +
          'agent so\'ralganidan chetga chiqayotgan bo\'lishi mumkin',
      )
      return true
    }
    if (this.jamiBlok >= JAMI_BLOK_CHEGARASI) {
      this.autoniOchir(`sessiyada jami ${JAMI_BLOK_CHEGARASI} marta bloklandi`)
      return true
    }
    return false
  }

  /**
   * Klassifikator ishlamadi (model topilmadi, timeout, buzuq javob).
   * Auto darhol o'chadi — "ehtimol xavfsizdir" deb taxmin qilmaymiz.
   */
  klassifikatorNosoz(xabar: string): void {
    if (this._rejim !== 'auto') return
    this.autoniOchir(`klassifikator ishlamadi: ${xabar}`)
  }

  private autoniOchir(sabab: string): void {
    this._rejim = 'tasdiq'
    this._sabab = sabab
    this.ketmaKetBlok = 0
    this.jamiBlok = 0
    this.xabarBer()
  }

  private xabarBer(): void {
    const ozgarish = this.holat
    for (const k of this.kuzatuvchilar) {
      try {
        k(ozgarish)
      } catch {
        // Kuzatuvchi xatosi rejim o'zgarishini buzmasin
      }
    }
  }

  /** Sessiya tugadi */
  yop(): void {
    this.kuzatuvchilar.clear()
  }
}

// ---------------------------------------------------------------------------
// Sessiya bo'yicha reestr
// ---------------------------------------------------------------------------

const boshqaruvchilar = new Map<string, RejimBoshqaruvchi>()

export function rejimBoshqaruvchisi(sessionId: string): RejimBoshqaruvchi {
  let mavjud = boshqaruvchilar.get(sessionId)
  if (!mavjud) {
    mavjud = new RejimBoshqaruvchi(sessionId)
    boshqaruvchilar.set(sessionId, mavjud)
  }
  return mavjud
}

export function rejimBoshqaruvchisiniYop(sessionId: string): void {
  boshqaruvchilar.get(sessionId)?.yop()
  boshqaruvchilar.delete(sessionId)
}

/** Testlar uchun */
export function rejimlarniTozala(): void {
  for (const b of boshqaruvchilar.values()) b.yop()
  boshqaruvchilar.clear()
}
