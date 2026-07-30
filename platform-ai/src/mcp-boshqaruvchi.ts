// Sessiya uchun ulangan MCP serverlar boshqaruvchisi.
//
// IKKI VAZIFA:
//   1) bir necha serverga ulanish va ularning tool'larini bitta ro'yxatga
//      yig'ish (nomlar prefikslanadi — `mcp-toollari.ts`);
//   2) HAR TOOL CHAQIRUVIDAN OLDIN RUXSAT SO'RASH.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA RUXSAT AYNAN SHU YERDA.                                         │
// │                                                                      │
// │ `muhit.ts` (`ChegaralanganMuhit`) fayl va buyruq uchun yagona darvoza:│
// │ tool undan chetlab o'tolmaydi, chunki tekshiruv metod ICHIDA.         │
// │ MCP chaqiruvi esa `ExecutionEnv` interfeysiga sig'maydi — u na fayl,  │
// │ na buyruq. Shuning uchun MCP uchun ALOHIDA darvoza kerak, lekin       │
// │ QOIDA BIR XIL: tekshiruv `chaqir()` metodi ichida, chaqiruvchida      │
// │ emas. `mcp-toollari.ts` dagi tool o'ramlari faqat shu metodni         │
// │ chaqiradi, ya'ni ruxsatni aylanib o'tish yo'li yo'q.                  │
// │                                                                      │
// │ Hook qatlami (`hooklar.ts`) YETARLI EMAS: u faqat QO'SHIMCHA cheklov  │
// │ qo'ya oladi va ruxsat SO'RAMAYDI. Hook bilan cheklansa, MCP tool      │
// │ "so'rovsiz bajariladi, keyin natijasi filtrlanadi" bo'lib qolardi —   │
// │ bu platformaning "xavfli amal oldidan so'raladi" tamoyiliga zid.      │
// └──────────────────────────────────────────────────────────────────────┘
//
// RUXSAT BOSHQARUVCHISI TASHQARIDAN OLINADI (yaratilmaydi). Shu tufayli
// "har doim ruxsat" naqshlari, blok hisoblagichlari va klassifikator
// konteksti fayl/buyruq so'rovlari BILAN BIR XIL holatni baham ko'radi:
// foydalanuvchi uchun ruxsat tizimi yagona, tool turiga qarab bo'linmaydi.

import { maxfiyniYashir } from './hooklar.ts'
import { McpKlient, type McpUlanishSozlamalari } from './mcp-klient.ts'
import type { McpToolNatijasi, McpToolTarifi } from './mcp-protokol.ts'
import type { RuxsatBoshqaruvchi } from './ruxsat.ts'

/** Sessiyada ulanishi kerak bo'lgan bitta server */
export interface McpUlanadiganServer {
  /** `mcp_serverlar.id` — diagnostika va tool bog'lash uchun */
  id: string
  /** Agentga ko'rinadigan nom — tool prefiksi shundan quriladi */
  nom: string
  sozlama: McpUlanishSozlamalari
}

/** Agentga e'lon qilinadigan bitta MCP tool */
export interface McpRoyxatYozuvi {
  serverId: string
  serverNomi: string
  tool: McpToolTarifi
}

/** Ruxsat so'rovidagi `nishon` uzunligi chegarasi */
const NISHON_CHEGARASI = 1000

/**
 * Argumentlarni ruxsat so'rovi uchun matnga aylantiradi.
 *
 * MAXFIY QIYMATLAR YASHIRILADI. Argumentlar UI'da foydalanuvchiga
 * ko'rinadi va auditga yoziladi; agent tokenni argument sifatida uzatgan
 * bo'lsa (masalan `{"token": "ghp_..."}`) u ekranga chiqmasligi kerak.
 * `hooklar.ts` dagi AYNI funksiya ishlatiladi — filtr bitta joyda.
 *
 * Eksport qilingan: test aynan shu chiqishni tekshiradi.
 */
export function argumentlarniNishonga(argumentlar: unknown): string {
  let xom: string
  try {
    xom = JSON.stringify(argumentlar ?? {}) ?? '{}'
  } catch {
    // Aylanma havola yoki serializatsiya qilinmaydigan qiymat — argumentlar
    // modeldan keladi, ya'ni bu kutilmagan holat, lekin ruxsat so'rovi
    // baribir chiqishi kerak.
    xom = '(argumentlarni o\'qib bo\'lmadi)'
  }
  const yashirilgan = maxfiyniYashir(xom)
  return yashirilgan.length > NISHON_CHEGARASI
    ? `${yashirilgan.slice(0, NISHON_CHEGARASI)}…`
    : yashirilgan
}

/**
 * "Har doim ruxsat" naqshi.
 *
 * GRANULARLIK — TOOL DARAJASIDA, server darajasida emas. Server darajasida
 * bo'lsa, bitta "Har doim" bosilishi bilan o'sha serverning BARCHA vositasi
 * (masalan `read_file` ham, `delete_repo` ham) abadiy ochilib qolardi.
 *
 * OCHIQ TRADEOFF: argument QIYMATI naqshga kirmaydi. `github.create_issue`
 * ga "har doim" berilsa, keyingi turli argumentli chaqiruvlar ham o'tadi.
 * Bu `muhit.ts` dagi buyruq naqshi (`git push`) bilan bir xil daraja —
 * izchillik uchun ataylab shunday.
 */
export function mcpNaqshi(serverNomi: string, toolNomi: string): string {
  return `mcp:${serverNomi}.${toolNomi}`
}

export class McpBoshqaruvchi {
  private klientlar = new Map<string, McpKlient>()
  private toollar = new Map<string, McpToolTarifi[]>()
  private nomlar = new Map<string, string>()
  /** serverId → ulanish xatosi. Diagnostika va UI uchun. */
  private xatolar = new Map<string, string>()
  private yopilgan = false

  constructor(
    readonly sessionId: string,
    private ruxsat: RuxsatBoshqaruvchi,
  ) {}

  /** Ulangan serverlar soni */
  get ulanganSoni(): number {
    return this.klientlar.size
  }

  /** Ulanmagan serverlar: serverId → xato matni */
  get ulanishXatolari(): ReadonlyMap<string, string> {
    return this.xatolar
  }

  /**
   * Berilgan serverlarga ulanadi va tool ro'yxatlarini yig'adi.
   *
   * XATO TASHLAMAYDI va HAR SERVER MUSTAQIL. Bittasi ishga tushmasa
   * (`npx` topilmadi, token yo'q, timeout) xato `xatolar` ga yoziladi va
   * qolganlari davom etadi. Sabab: foydalanuvchi bitta buzuq server
   * tufayli butun chatdan foydalanolmay qolmasligi kerak — bu
   * `standart-skilllar.ts` va `loyiha-konteksti.ts` dagi bilan bir xil
   * qoida ("qulaylik qatlami sessiyani yiqitmaydi").
   *
   * PARALLEL ulanadi: 5 ta server ketma-ket 10 soniyalik timeout bilan
   * ulansa, sessiya boshlanishi 50 soniyaga cho'zilardi.
   */
  async ulash(serverlar: readonly McpUlanadiganServer[], signal?: AbortSignal): Promise<void> {
    if (this.yopilgan) return

    await Promise.all(
      serverlar.map(async (s) => {
        this.nomlar.set(s.id, s.nom)
        const klient = new McpKlient(s.sozlama)
        try {
          await klient.ulan(signal)
          const toollar = await klient.toollarniOl(signal)
          // Oqim shu orada bekor qilingan bo'lishi mumkin
          if (this.yopilgan) {
            await klient.uz()
            return
          }
          this.klientlar.set(s.id, klient)
          this.toollar.set(s.id, toollar)
        } catch (xato) {
          this.xatolar.set(s.id, xato instanceof Error ? xato.message : String(xato))
          // Yarim ulangan klient ortda qolmasin
          await klient.uz().catch(() => undefined)
        }
      }),
    )
  }

  /** Agentga e'lon qilinadigan tool'lar — server nomi bilan */
  royxat(): McpRoyxatYozuvi[] {
    const natija: McpRoyxatYozuvi[] = []
    for (const [serverId, toollar] of this.toollar) {
      const serverNomi = this.nomlar.get(serverId) ?? serverId
      for (const tool of toollar) natija.push({ serverId, serverNomi, tool })
    }
    return natija
  }

  /**
   * Tool chaqiradi — RUXSATDAN KEYIN.
   *
   * Ruxsat berilmasa XATO TASHLANADI: agent uni tool xatosi sifatida
   * ko'radi va boshqa yo'l izlaydi. `muhit.ts` dagi rad etilgan amal bilan
   * bir xil xulq.
   */
  async chaqir(
    serverId: string,
    toolNomi: string,
    argumentlar: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolNatijasi> {
    const klient = this.klientlar.get(serverId)
    const serverNomi = this.nomlar.get(serverId) ?? serverId
    if (!klient) {
      const sabab = this.xatolar.get(serverId)
      throw new Error(
        sabab
          ? `MCP server ulanmagan: ${serverNomi} (${sabab})`
          : `MCP server topilmadi: ${serverNomi}`,
      )
    }

    const javob = await this.ruxsat.sora({
      tur: 'mcp',
      amal: `${serverNomi}.${toolNomi}`,
      nishon: argumentlarniNishonga(argumentlar),
      sabab: `"${serverNomi}" MCP serverining "${toolNomi}" vositasi tashqi tizimga murojaat qiladi`,
      naqsh: mcpNaqshi(serverNomi, toolNomi),
    })

    if (javob === 'rad') {
      throw new Error(`Ruxsat berilmadi: ${serverNomi}.${toolNomi}`)
    }

    return klient.chaqir(toolNomi, argumentlar, signal)
  }

  /**
   * Hamma ulanishni yopadi — ZOMBI JARAYON QOLDIRMASLIK shu yerda.
   *
   * `agent.ts` dagi `tozala()` dan chaqiriladi. Ikki marta chaqirilishi
   * xavfsiz va xato tashlamaydi: tozalash har qanday holatda oxirigacha
   * borishi kerak.
   */
  async yop(): Promise<void> {
    if (this.yopilgan) return
    this.yopilgan = true

    const klientlar = [...this.klientlar.values()]
    this.klientlar.clear()
    this.toollar.clear()

    await Promise.all(klientlar.map((k) => k.uz().catch(() => undefined)))
  }
}
