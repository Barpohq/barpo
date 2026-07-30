// Bitta MCP serverga ulanish: handshake, tool ro'yxati, tool chaqiruvi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ XATO IZOLYATSIYASI — bu sinfning ASOSIY vazifasi.                    │
// │                                                                      │
// │ MCP server uchinchi tomon kodi: ishga tushmasligi, javob bermasligi, │
// │ o'rtada o'lib qolishi mumkin. Bunday hollarda SESSIYA ISHLASHDA      │
// │ DAVOM ETISHI kerak — foydalanuvchi bitta buzuq server tufayli        │
// │ chatdan foydalanolmay qolmasin.                                      │
// │                                                                      │
// │ Shu sabab har `McpKlient` mustaqil: uning xatosi `Error` bo'lib      │
// │ chaqiruvchiga qaytadi (`McpBoshqaruvchi` uni ushlaydi va o'sha       │
// │ serverni "ishlamaydi" deb belgilaydi), boshqa serverlarga yoki       │
// │ agent oqimiga yopishmaydi.                                          │
// └──────────────────────────────────────────────────────────────────────┘
//
// RUXSAT BU YERDA SO'RALMAYDI. `chaqir()` faqat protokol ishini qiladi.
// Ruxsat qatlami bir pog'ona yuqorida — `McpBoshqaruvchi.chaqir()` ichida
// (`mcp-boshqaruvchi.ts`). Sabab: bu sinf sessiya va foydalanuvchi haqida
// hech narsa bilmaydi, u faqat bitta ulanishni boshqaradi.

import {
  javobmi,
  MCP_PROTOKOL_VERSIYASI,
  natijaniAjrat,
  toollarniAjrat,
  type JsonRpcJavob,
  type JsonRpcKelgan,
  type McpServerMalumoti,
  type McpToolNatijasi,
  type McpToolTarifi,
} from './mcp-protokol.ts'
import { httpTransportYarat, stdioTransportYarat, type McpTransport } from './mcp-transport.ts'

/** Handshake uchun standart kutish muddati */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000

/** Bitta tool chaqiruvi uchun standart kutish muddati */
export const MCP_CHAQIRUV_TIMEOUT_MS = 30_000

export interface McpUlanishSozlamalari {
  transport: 'stdio' | 'http'
  /** `stdio`: ishga tushirish buyrug'i */
  buyruq?: string
  /** `stdio`: argumentlar (o'rin egallovchilar almashtirilgan holda) */
  argumentlar?: string[]
  /** `http`: server manzili */
  url?: string
  /** `stdio`: qo'shimcha env o'zgaruvchilari */
  env?: Record<string, string>
  /** `http`: qo'shimcha sarlavhalar */
  sarlavhalar?: Record<string, string>
  handshakeTimeoutMs?: number
  chaqiruvTimeoutMs?: number
}

interface Kutayotgan {
  yech: (javob: JsonRpcJavob) => void
  rad: (xato: Error) => void
  taymer: ReturnType<typeof setTimeout>
}

export class McpKlient {
  private transport: McpTransport | undefined
  private keyingiId = 1
  private kutayotganlar = new Map<number, Kutayotgan>()
  private tinglovchiBekor: (() => void) | undefined
  private toollarKeshi: McpToolTarifi[] | undefined
  private ulangan = false
  private yopilgan = false
  private serverMalumoti: McpServerMalumoti | undefined

  constructor(private sozlama: McpUlanishSozlamalari) {}

  /** Handshake bajarilganmi */
  get tayyormi(): boolean {
    return this.ulangan && !this.yopilgan
  }

  /** Server o'zi haqida aytgani — diagnostika uchun */
  get malumot(): McpServerMalumoti | undefined {
    return this.serverMalumoti
  }

  /**
   * Ulanadi va handshake bajaradi: `initialize` → `notifications/initialized`.
   *
   * XATO TASHLAYDI — chaqiruvchi (`McpBoshqaruvchi`) uni ushlab, serverni
   * ishlamaydigan deb belgilaydi. Xato matniga stderr ning oxirgi qismi
   * qo'shiladi: "npx: command not found" kabi sabablar aynan o'sha yerda
   * ko'rinadi va usiz foydalanuvchi nima bo'lganini bilmasdi.
   */
  async ulan(signal?: AbortSignal): Promise<void> {
    if (this.ulangan) return
    if (this.yopilgan) throw new Error('MCP klient yopilgan')

    this.transport = this.transportYarat()
    this.tinglovchiBekor = this.transport.tingla((xabar) => this.xabarKeldi(xabar))

    const timeout = this.sozlama.handshakeTimeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS
    try {
      const natija = await this.sorov(
        'initialize',
        {
          protocolVersion: MCP_PROTOKOL_VERSIYASI,
          // Bizda hozircha faqat tool ishlatish qobiliyati bor:
          // `roots`/`sampling` e'lon qilmaymiz, chunki ularni bajarmaymiz.
          // Yolg'on e'lon qilsak server bizga so'rov yuborib javob kutardi.
          capabilities: {},
          clientInfo: { name: 'platforma', version: '0.1.0' },
        },
        timeout,
        signal,
      )
      this.serverMalumoti = (natija ?? undefined) as McpServerMalumoti | undefined

      // Spec talabi: initialize javobidan keyin xabarnoma yuboriladi.
      // Javob kutilmaydi.
      //
      // XATOSI YUTILADI. Xabarnoma — bir tomonlama xabar va uning
      // yetib-yetmagani ulanish holatini o'zgartirmaydi: `initialize`
      // allaqachon muvaffaqiyatli bo'ldi, ya'ni server tayyor.
      //
      // HTTP'da bu AMALDA UCHRAYDI: ba'zi serverlar xabarnomaga 4xx
      // qaytaradi (ular uni kutilmagan so'rov deb hisoblaydi). Xatoni
      // o'tkazib yuborsak, ishlaydigan serverga ulanish shu bosqichda
      // bekorga yiqilardi.
      try {
        await this.transport.yubor({ jsonrpc: '2.0', method: 'notifications/initialized' })
      } catch {
        // yuqoridagi izohga q.
      }
      this.ulangan = true
    } catch (xato) {
      // Handshake muvaffaqiyatsiz — jarayonni ORTDA QOLDIRMAYMIZ
      const izoh = this.xatoIzohi()
      await this.uz()
      const asos = xato instanceof Error ? xato.message : String(xato)
      throw new Error(izoh ? `${asos} (server chiqishi: ${izoh})` : asos)
    }
  }

  /**
   * Server e'lon qilgan tool'lar.
   *
   * NATIJA KESHLANADI. Spec'da server tool ro'yxati o'zgarganini
   * `notifications/tools/list_changed` bilan bildirishi mumkin, lekin biz
   * unga hozircha reaksiya qilmaymiz: agentga tool ro'yxati bir marta,
   * sessiya boshida e'lon qilinadi va o'rtada o'zgarishi baribir modelga
   * yetib bormasdi.
   */
  async toollarniOl(signal?: AbortSignal): Promise<McpToolTarifi[]> {
    if (this.toollarKeshi) return this.toollarKeshi
    this.ulanganiniTekshir()
    const natija = await this.sorov(
      'tools/list',
      {},
      this.sozlama.chaqiruvTimeoutMs ?? MCP_CHAQIRUV_TIMEOUT_MS,
      signal,
    )
    this.toollarKeshi = toollarniAjrat(natija)
    return this.toollarKeshi
  }

  /**
   * Tool chaqiradi.
   *
   * `isError: true` natija XATO TASHLAMAYDI — u agentga oddiy natija bo'lib
   * boradi (`mcp-toollari.ts` uni tool xatosi sifatida belgilaydi). Sabab:
   * "fayl topilmadi" kabi javob modelning ishlashiga kerak bo'lgan
   * ma'lumot, ulanishni buzadigan holat emas.
   */
  async chaqir(
    toolNomi: string,
    argumentlar: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolNatijasi> {
    this.ulanganiniTekshir()
    const natija = await this.sorov(
      'tools/call',
      { name: toolNomi, arguments: argumentlar ?? {} },
      this.sozlama.chaqiruvTimeoutMs ?? MCP_CHAQIRUV_TIMEOUT_MS,
      signal,
    )
    return natijaniAjrat(natija)
  }

  /**
   * Ulanishni uzadi va jarayonni o'ldiradi.
   *
   * XATO TASHLAMAYDI va IKKI MARTA chaqirilishi xavfsiz — sessiya
   * tozalanishida bu muhim (`agent.ts` dagi `tozala()` bir necha yo'ldan
   * chaqirilishi mumkin).
   */
  async uz(): Promise<void> {
    if (this.yopilgan) return
    this.yopilgan = true
    this.ulangan = false

    // Kutayotgan so'rovlar abadiy osilib qolmasin
    for (const [, kutayotgan] of this.kutayotganlar) {
      clearTimeout(kutayotgan.taymer)
      kutayotgan.rad(new Error('MCP ulanishi yopildi'))
    }
    this.kutayotganlar.clear()

    this.tinglovchiBekor?.()
    this.tinglovchiBekor = undefined

    try {
      await this.transport?.yop()
    } catch {
      // yopishdagi xato tozalashni buzmasin
    }
    this.transport = undefined
  }

  // -------------------------------------------------------------------------
  // Ichki
  // -------------------------------------------------------------------------

  private transportYarat(): McpTransport {
    if (this.sozlama.transport === 'stdio') {
      if (!this.sozlama.buyruq) throw new Error("stdio uchun buyruq ko'rsatilmagan")
      return stdioTransportYarat(
        this.sozlama.buyruq,
        this.sozlama.argumentlar ?? [],
        this.sozlama.env ?? {},
      )
    }

    if (this.sozlama.transport === 'http') {
      if (!this.sozlama.url) throw new Error("http uchun url ko'rsatilmagan")
      return httpTransportYarat(
        this.sozlama.url,
        this.sozlama.sarlavhalar ?? {},
        this.sozlama.chaqiruvTimeoutMs ?? MCP_CHAQIRUV_TIMEOUT_MS,
      )
    }

    throw new Error(`Noma'lum transport: ${String(this.sozlama.transport)}`)
  }

  private xatoIzohi(): string {
    const t = this.transport as (McpTransport & { xatoMatni?: () => string }) | undefined
    return t?.xatoMatni?.() ?? ''
  }

  private ulanganiniTekshir(): void {
    if (!this.ulangan || this.yopilgan) throw new Error('MCP server ulanmagan')
  }

  /**
   * So'rov yuboradi va javobni kutadi.
   *
   * Uch yo'l bilan tugashi mumkin: javob keldi, muddat tugadi, bekor
   * qilindi. Uchalasida ham `kutayotganlar` dan yozuv olib tashlanadi —
   * aks holda uzoq sessiyada xarita o'sib borardi.
   */
  private async sorov(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const transport = this.transport
    if (!transport) throw new Error('MCP transport yo\'q')
    if (signal?.aborted) throw new Error("So'rov bekor qilindi")

    const id = this.keyingiId++

    const javob = await new Promise<JsonRpcJavob>((yech, rad) => {
      const yakunla = (xato?: Error) => {
        const kutayotgan = this.kutayotganlar.get(id)
        if (!kutayotgan) return
        this.kutayotganlar.delete(id)
        clearTimeout(kutayotgan.taymer)
        signal?.removeEventListener('abort', bekorQil)
        if (xato) rad(xato)
      }

      const bekorQil = () => yakunla(new Error("So'rov bekor qilindi"))
      const taymer = setTimeout(
        () => yakunla(new Error(`MCP javob bermadi (${method}, ${timeoutMs}ms)`)),
        timeoutMs,
      )
      taymer.unref?.()
      signal?.addEventListener('abort', bekorQil, { once: true })

      this.kutayotganlar.set(id, {
        yech: (j) => {
          signal?.removeEventListener('abort', bekorQil)
          yech(j)
        },
        rad: (x) => {
          signal?.removeEventListener('abort', bekorQil)
          rad(x)
        },
        taymer,
      })

      transport.yubor({ jsonrpc: '2.0', id, method, params }).catch((x: unknown) => {
        yakunla(x instanceof Error ? x : new Error(String(x)))
      })
    })

    if (javob.error) {
      throw new Error(`MCP xatosi (${method}): ${javob.error.message}`)
    }
    return javob.result
  }

  private xabarKeldi(xabar: JsonRpcKelgan): void {
    // Xabarnomalar (masalan `notifications/message`) hozircha e'tiborsiz:
    // ularni ishlatadigan qism yo'q. Kelajakda `tools/list_changed` shu
    // yerdan ushlanadi.
    if (!javobmi(xabar)) return

    const kutayotgan = this.kutayotganlar.get(xabar.id)
    if (!kutayotgan) return // muddati tugagan yoki noma'lum id
    this.kutayotganlar.delete(xabar.id)
    clearTimeout(kutayotgan.taymer)
    kutayotgan.yech(xabar)
  }
}
