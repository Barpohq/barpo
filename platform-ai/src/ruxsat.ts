// Ruxsat tizimi — agent xavfli amalga urinsa foydalanuvchidan so'raydi.
//
// Ish papkasi ichidagi oddiy amallar so'ralmaydi (muhit.ts va buyruq-tahlil.ts
// hal qiladi). Bu modul faqat "so'rash kerak" deb topilgan holatlarni
// boshqaradi: so'rovni ro'yxatga oladi, javob kelguncha kutadi, "har doim"
// tanlovini eslab qoladi.
//
// Nega Promise? pi-agent-core ning `beforeToolCall` hooki async — javob
// kelguncha uni ushlab tursak, agent loop o'zi to'xtab turadi. Alohida
// holat mashinasi kerak emas.
//
// Javob kelmasa 5 daqiqada RAD etiladi: aks holda agent (va u bilan birga
// sessiya) abadiy osilib qolardi.

import type { KlassifikatorQarori, RuxsatJavobi, RuxsatSorovi, RuxsatTuri } from '@platforma/shared'
import { amalniBahola, type KlassifikatorXabari } from './klassifikator.ts'
import { SessiyaReestri } from './reestr.ts'
import type { RejimBoshqaruvchi } from './rejim.ts'

/** Javob kutish muddati */
export const RUXSAT_KUTISH_MS = 5 * 60 * 1000

interface Kutayotgan {
  sorov: RuxsatSorovi
  yech: (javob: RuxsatJavobi) => void
  taymer: ReturnType<typeof setTimeout>
}

export interface RuxsatSorash {
  tur: RuxsatTuri
  amal: string
  nishon: string
  sabab: string
  naqsh: string
}

/** So'rov paydo bo'lganda chaqiriladi — orchestrator uni WS'ga uzatadi */
export type SorovKuzatuvchi = (sorov: RuxsatSorovi) => void

/** Klassifikator qaror chiqarganda chaqiriladi — UI'da yorliq ko'rsatiladi */
export type QarorKuzatuvchi = (qaror: KlassifikatorQarori) => void

/**
 * Klassifikator uchun kerakli kontekst.
 *
 * `suhbat` — TOOL NATIJALARISIZ tarix. Uni `agent.ts` tayyorlaydi va shu
 * yerga beradi; ruxsat qatlami uni o'zgartirmaydi, faqat uzatadi.
 */
export interface KlassifikatorKonteksti {
  rejim: RejimBoshqaruvchi
  suhbat: KlassifikatorXabari[]
  ishPapkasi: string
  signal?: AbortSignal
  /** Configdagi `ruxsat.klassifikatorModeli` — berilmasa avtomatik tanlanadi */
  model?: string | null
}

/**
 * Bitta sessiya uchun ruxsat holati.
 *
 * "Har doim" tanlovlari shu obyekt ichida qoladi — sessiya tugasa unutiladi.
 * Bazaga yozilmaydi: doimiy ruxsatlar uchun alohida sozlamalar UI'si kerak,
 * u keyingi bosqichda.
 */
export class RuxsatBoshqaruvchi {
  private kutayotganlar = new Map<string, Kutayotgan>()
  private hardoimNaqshlar = new Set<string>()
  private kuzatuvchilar = new Set<SorovKuzatuvchi>()
  private qarorKuzatuvchilar = new Set<QarorKuzatuvchi>()
  private klassifikatorKonteksti: KlassifikatorKonteksti | undefined
  private yopilgan = false
  /**
   * Javob kutish muddati. Configdan keladi; berilmasa `RUXSAT_KUTISH_MS`.
   *
   * Muddat tugasa so'rov RAD etiladi — hech qachon avtomatik ruxsatga
   * aylanmaydi. Shuning uchun uni configdan boshqarish xavfsiz: eng yomon
   * holatda foydalanuvchi javob berishga ulgurmaydi va amal bajarilmaydi.
   */
  private kutishMs = RUXSAT_KUTISH_MS

  constructor(readonly sessionId: string) {}

  /** Javob kutish muddatini configdan o'rnatadi */
  kutishMuddatiniOrnat(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.kutishMs = ms
  }

  /**
   * Klassifikator kontekstini o'rnatadi. Har javob oqimi boshida `agent.ts`
   * chaqiradi — suhbat tarixi yangilanib turishi kerak.
   *
   * Kontekst berilmagan bo'lsa klassifikator ishlatilmaydi (tasdiq rejimi).
   */
  klassifikatorniUla(kontekst: KlassifikatorKonteksti | undefined): void {
    this.klassifikatorKonteksti = kontekst
  }

  /** Klassifikator qarorlarini kuzatish */
  qarorlarniKuzat(kuzatuvchi: QarorKuzatuvchi): () => void {
    this.qarorKuzatuvchilar.add(kuzatuvchi)
    return () => {
      this.qarorKuzatuvchilar.delete(kuzatuvchi)
    }
  }

  /** So'rovlarni kuzatish. Bekor qiluvchi funksiya qaytaradi. */
  kuzat(kuzatuvchi: SorovKuzatuvchi): () => void {
    this.kuzatuvchilar.add(kuzatuvchi)
    return () => {
      this.kuzatuvchilar.delete(kuzatuvchi)
    }
  }

  /** Naqsh allaqachon "har doim" ro'yxatidami */
  hardoimRuxsatmi(naqsh: string): boolean {
    return this.hardoimNaqshlar.has(naqsh)
  }

  /** Testlar va diagnostika uchun */
  get hardoimlar(): string[] {
    return [...this.hardoimNaqshlar]
  }

  /** Hozir javob kutayotgan so'rovlar */
  get kutayotganSorovlar(): RuxsatSorovi[] {
    return [...this.kutayotganlar.values()].map((k) => k.sorov)
  }

  /**
   * Ruxsat so'raydi va javob kelguncha kutadi.
   *
   * `hardoim` ro'yxatidagi naqsh darhol `ruxsat` qaytaradi — kuzatuvchilar
   * ham chaqirilmaydi (UI'da ortiqcha karta chiqmasin).
   */
  async sora(sorash: RuxsatSorash): Promise<RuxsatJavobi> {
    if (this.yopilgan) return 'rad'
    if (sorash.naqsh && this.hardoimNaqshlar.has(sorash.naqsh)) return 'ruxsat'

    // --- Auto rejim: klassifikator hal qiladi ---
    const kontekst = this.klassifikatorKonteksti
    if (kontekst && kontekst.rejim.rejim === 'auto') {
      const natija = await amalniBahola(
        {
          suhbat: kontekst.suhbat,
          amal: {
            tur: sorash.tur,
            nishon: sorash.nishon,
            qaysiTool: sorash.amal,
            statikSabab: sorash.sabab,
          },
          ishPapkasi: kontekst.ishPapkasi,
          model: kontekst.model,
        },
        kontekst.signal,
      )

      if (natija.qaror === 'ruxsat') {
        kontekst.rejim.ruxsatBerildi()
        this.qarorBer({ qaror: 'ruxsat', izoh: natija.izoh })
        return 'ruxsat'
      }
      if (natija.qaror === 'blok') {
        kontekst.rejim.blokBoldi()
        this.qarorBer({ qaror: 'blok', izoh: natija.izoh })
        return 'rad'
      }
      // nosoz — auto o'chadi, so'rov foydalanuvchiga tushadi (pastda davom etadi)
      kontekst.rejim.klassifikatorNosoz(natija.xabar)
    }

    const sorov: RuxsatSorovi = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      tur: sorash.tur,
      amal: sorash.amal,
      nishon: sorash.nishon,
      sabab: sorash.sabab,
      naqsh: sorash.naqsh,
      vaqt: new Date().toISOString(),
    }

    return new Promise<RuxsatJavobi>((yech) => {
      const taymer = setTimeout(() => {
        this.kutayotganlar.delete(sorov.id)
        yech('rad')
      }, this.kutishMs)
      // Node'da timer jarayonni ushlab turmasin
      taymer.unref?.()

      this.kutayotganlar.set(sorov.id, { sorov, yech, taymer })

      for (const k of this.kuzatuvchilar) {
        try {
          k(sorov)
        } catch {
          // Kuzatuvchi xatosi so'rovni buzmasin
        }
      }
    })
  }

  private qarorBer(qaror: KlassifikatorQarori): void {
    for (const k of this.qarorKuzatuvchilar) {
      try {
        k(qaror)
      } catch {
        // Kuzatuvchi xatosi qarorni buzmasin
      }
    }
  }

  /**
   * Foydalanuvchi javobi. Noma'lum id — `false` (masalan timeout o'tib ketgan).
   */
  javobBer(sorovId: string, javob: RuxsatJavobi): boolean {
    const kutayotgan = this.kutayotganlar.get(sorovId)
    if (!kutayotgan) return false

    clearTimeout(kutayotgan.taymer)
    this.kutayotganlar.delete(sorovId)

    if (javob === 'hardoim' && kutayotgan.sorov.naqsh) {
      this.hardoimNaqshlar.add(kutayotgan.sorov.naqsh)
    }
    kutayotgan.yech(javob === 'hardoim' ? 'ruxsat' : javob)
    return true
  }

  /**
   * Hamma kutayotgan so'rovni rad etadi va yangi so'rovlarni to'xtatadi.
   * Sessiya tugaganda yoki oqim bekor qilinganda chaqiriladi.
   */
  yop(): void {
    this.yopilgan = true
    for (const kutayotgan of this.kutayotganlar.values()) {
      clearTimeout(kutayotgan.taymer)
      kutayotgan.yech('rad')
    }
    this.kutayotganlar.clear()
    this.kuzatuvchilar.clear()
    this.qarorKuzatuvchilar.clear()
    this.klassifikatorKonteksti = undefined
  }
}

/**
 * Sessiya bo'yicha boshqaruvchilar reestri.
 *
 * TTL + LRU bilan — batafsil asos `reestr.ts` boshidagi izohda. Qisqasi:
 * chat sessiyalari bazada abadiy qoladi va "o'chirildi" hodisasi yo'q,
 * shuning uchun faolsizlik bo'yicha tozalash yagona ishonchli yo'l.
 */
const boshqaruvchilar = new SessiyaReestri<RuxsatBoshqaruvchi>(
  (sessionId) => new RuxsatBoshqaruvchi(sessionId),
)

export function ruxsatBoshqaruvchisi(sessionId: string): RuxsatBoshqaruvchi {
  return boshqaruvchilar.ol(sessionId)
}

export function ruxsatBoshqaruvchisiniYop(sessionId: string): void {
  boshqaruvchilar.yop(sessionId)
}

/** Hozir saqlanayotgan ruxsat boshqaruvchilari soni — diagnostika uchun */
export function ruxsatBoshqaruvchilarSoni(): number {
  return boshqaruvchilar.soni
}

/** Testlar uchun: hamma boshqaruvchini tozalash */
export function ruxsatlarniTozala(): void {
  boshqaruvchilar.tozala()
}
