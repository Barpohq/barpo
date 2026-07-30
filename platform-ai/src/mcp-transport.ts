// MCP transport qatlami — xabarlar qanday yetkaziladi.
//
// Klient (`mcp-klient.ts`) transport tafsilotini BILMAYDI: u faqat JSON-RPC
// xabar yuboradi va kelganini tinglaydi. Shu tufayli stdio va HTTP bir xil
// klient kodi bilan ishlaydi.
//
// stdio — mahalliy jarayon (`npx`/`uvx`/`docker`), newline-delimited JSON
//         stdin/stdout orqali. Ekotizimning katta qismi shunday.
// http  — masofaviy server (`streamable-http`/`sse`), bosqich 3 da qo'shiladi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ SHELL ISHLATILMAYDI. `Bun.spawn(argv)` argv MASSIVINI oladi —        │
// │ buyruq satri emas. Ya'ni argument ichidagi `;rm -rf ~` kabi matn     │
// │ oddiy satr bo'lib qoladi, hech qachon bajarilmaydi.                  │
// │                                                                      │
// │ Bu rasmiy MCP spec tavsiyasi. `Argument` ta'rifidagi ogohlantirish:  │
// │ "Clients should prefer non-shell execution methods (e.g. posix_spawn)│
// │ when possible to eliminate injection risks entirely."                │
// │                                                                      │
// │ Registry'dan kelgan argumentlarda `{token}` kabi o'rin egallovchilar │
// │ bo'ladi — ular ham SHU MASSIV ichida, `String.replace` bilan         │
// │ almashtiriladi (`mcp-registry.ts`), ya'ni shell'ga yaqinlashmaydi.   │
// └──────────────────────────────────────────────────────────────────────┘

import type { JsonRpcKelgan, JsonRpcSorov, JsonRpcXabarnoma } from './mcp-protokol.ts'

export interface McpTransport {
  /** Bitta JSON-RPC xabar yuboradi (so'rov yoki xabarnoma) */
  yubor(xabar: JsonRpcSorov | JsonRpcXabarnoma): Promise<void>
  /** Kelayotgan xabarlarni tinglaydi. Bekor qiluvchi funksiya qaytaradi. */
  tingla(fn: (xabar: JsonRpcKelgan) => void): () => void
  /**
   * Transportni yopadi — jarayonni o'ldiradi yoki ulanishni uzadi.
   *
   * XATO TASHLAMAYDI: yopish har qanday holatda oxirigacha borishi kerak,
   * aks holda jarayon yetim qolardi.
   */
  yop(): Promise<void>
}

// ---------------------------------------------------------------------------
// Jarayon abstraksiyasi (testlarda almashtiriladi)
// ---------------------------------------------------------------------------

/**
 * Ko'tarilgan jarayonning bizga kerak bo'lgan yuzasi.
 *
 * `Bun.spawn` natijasining TOR qismi. Ataylab tor: testdagi soxta jarayon
 * `Subprocess` ning o'nlab maydonini emas, faqat shu beshtasini bajarishi
 * kerak.
 */
export interface McpJarayon {
  /** Serverga yozish (stdin) */
  yoz(matn: string): void
  /** Serverdan kelgan matn (stdout) — qatorlarga ajratilmagan xom oqim */
  chiqishniTingla(fn: (bolak: string) => void): void
  /** Diagnostika oqimi (stderr) — protokol qismi EMAS */
  xatoOqiminiTingla(fn: (bolak: string) => void): void
  /** Muloyim to'xtatish (SIGTERM) */
  toxtat(): void
  /** Majburiy o'ldirish (SIGKILL) */
  old(): void
  /** Jarayon tugaganini kutish */
  tugadi: Promise<number>
}

export type JarayonYaratuvchi = (
  argv: string[],
  env: Record<string, string>,
) => McpJarayon

/**
 * Jarayon xulqini o'zgartira oladigan env o'zgaruvchilari — TAQIQLANGAN.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ NEGA BU RO'YXAT KERAK — HAQIQIY HUJUM YO'LI.                         │
 * │                                                                      │
 * │ MCP serverning `server.json` fayli o'zi qanday env o'zgaruvchilari    │
 * │ so'rashini E'LON QILADI (`environmentVariables[].name`) va bu fayl    │
 * │ UCHINCHI TOMON yozgan: u rasmiy registry'dan yoki skanerlangan        │
 * │ GitHub repo'dan keladi.                                              │
 * │                                                                      │
 * │ Ro'yxatsiz hujum shunday bo'lardi: zararli yozuv muallifi ISHONCHLI   │
 * │ paketni (masalan rasmiy MCP serverni) `buyruq`/`argumentlar` da       │
 * │ ko'rsatadi — foydalanuvchi UI'da buyruqni ko'rib ishonadi. Lekin      │
 * │ yozuvda `{"name": "NODE_OPTIONS", "default": "--require=/tmp/x.js"}` │
 * │ degan "sozlama" ham bo'ladi. Standart qiymat UI'da inputga           │
 * │ TO'LDIRILIB kelardi va "majburiy maydon" tekshiruvidan ham o'tardi,   │
 * │ ya'ni foydalanuvchi bitta tugma bosishi bilan begona kod ishga        │
 * │ tushardi — ishonchli paketning jarayoni ichida.                      │
 * │                                                                      │
 * │ Bu platformaning "qanday buyruq ishga tushishini ko'rsatamiz" degan   │
 * │ shaffoflik kafolatini buzardi: buyruq ko'rinadi, env esa YO'Q.        │
 * │                                                                      │
 * │ TEKSHIRUV AYNAN SHU YERDA — `spawn` dan oldingi oxirgi nuqta.        │
 * │ Yuqoridagi qatlamlarda (`mcp-ulash.ts`, `routes/mcp.ts`) ham filtr    │
 * │ bor, lekin ular chetlab o'tilishi mumkin; bu yerdan o'tolmaydi       │
 * │ (`muhit.ts` dagi "tekshiruv metod ichida" qoidasi bilan bir xil).     │
 * └──────────────────────────────────────────────────────────────────────┘
 */
const TAQIQLANGAN_ENV = new Set([
  // Dinamik yuklovchi — ixtiyoriy kod ishga tushiradi
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  // Node/Bun: `--require` bilan modul yuklaydi
  'NODE_OPTIONS',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  // Python: `-c` kabi kod, yoki import yo'lini almashtirish
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  // Bajariladigan fayl qidiruvi — soxta `npx` ni ko'rsatish
  'PATH',
  'NODE_PATH',
  // Shell ishga tushsa boshlang'ich fayl orqali kod
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
  // Perl/Ruby yuklovchilari
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
])

/**
 * Xavfli env kalitlarini olib tashlaydi.
 *
 * Solishtirish KATTA HARFDA: `ld_preload` va `LD_PRELOAD` ba'zi
 * tizimlarda bir xil ishlaydi, shuning uchun harf registriga tayanmaymiz.
 *
 * Eksport qilingan — test aynan shu funksiyani tekshiradi.
 */
export function envniTozala(env: Record<string, string>): {
  toza: Record<string, string>
  tashlangan: string[]
} {
  const toza: Record<string, string> = {}
  const tashlangan: string[] = []
  for (const [nom, qiymat] of Object.entries(env)) {
    if (TAQIQLANGAN_ENV.has(nom.toUpperCase())) {
      tashlangan.push(nom)
      continue
    }
    toza[nom] = qiymat
  }
  return { toza, tashlangan }
}

/**
 * `Bun.spawn` ustidagi standart implementatsiya.
 *
 * `env` PROCESS ENV BILAN BIRLASHTIRILADI: MCP serverlar odatda `PATH`
 * (npx/uvx topilishi uchun) va `HOME` ga tayanadi. Faqat berilgan qiymatlar
 * bilan ishga tushirsak, ular umuman ko'tarilmasdi.
 *
 * LEKIN jarayon xulqini o'zgartiradigan kalitlar OLIB TASHLANADI
 * (`TAQIQLANGAN_ENV` izohiga q.) — ular `process.env` dagi haqiqiy
 * qiymatda qoladi.
 */
const standartJarayonYaratuvchi: JarayonYaratuvchi = (argv, env) => {
  const { toza, tashlangan } = envniTozala(env)
  if (tashlangan.length > 0) {
    // Jimgina tashlamaymiz: foydalanuvchi nega sozlamasi ishlamaganini
    // bilishi kerak va bu yozuv zararli yozuvni aniqlashga yordam beradi.
    console.warn(
      `[mcp] xavfli env o'zgaruvchilari e'tiborsiz qoldirildi: ${tashlangan.join(', ')}`,
    )
  }

  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...toza },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const yozuvchi = proc.stdin

  return {
    yoz(matn) {
      yozuvchi.write(matn)
      yozuvchi.flush()
    },
    chiqishniTingla(fn) {
      void oqimniOqi(proc.stdout, fn)
    },
    xatoOqiminiTingla(fn) {
      void oqimniOqi(proc.stderr, fn)
    },
    toxtat() {
      proc.kill('SIGTERM')
    },
    old() {
      proc.kill('SIGKILL')
    },
    tugadi: proc.exited,
  }
}

/** ReadableStream'ni matn bo'laklariga aylantiradi */
async function oqimniOqi(oqim: ReadableStream<Uint8Array>, fn: (b: string) => void): Promise<void> {
  const dekoder = new TextDecoder()
  try {
    for await (const bolak of oqim) {
      fn(dekoder.decode(bolak, { stream: true }))
    }
  } catch {
    // Jarayon yopilganda oqim uziladi — bu normal holat, xato emas
  }
}

let jarayonYaratuvchi: JarayonYaratuvchi = standartJarayonYaratuvchi

/**
 * Testlar uchun: jarayon yaratuvchini almashtirish (`null` — standart).
 *
 * `ssh.ts` dagi `bajaruvchiOrnat()` bilan bir xil uslub.
 */
export function jarayonYaratuvchiniOrnat(y: JarayonYaratuvchi | null): void {
  jarayonYaratuvchi = y ?? standartJarayonYaratuvchi
}

// ---------------------------------------------------------------------------
// Tirik jarayonlar reestri — oxirgi himoya qatlami
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA KERAK. Jarayonlar UCH QATLAMDA yopiladi:                        │
// │   1) `McpKlient.uz()` — normal yo'l;                                  │
// │   2) `agent.ts` dagi `tozala()` — oqim tugaganda/bekor qilinganda;   │
// │   3) SHU REESTR — server `SIGTERM` olganda.                          │
// │                                                                      │
// │ Uchinchisi zarur, chunki `process.exit()` bola jarayonlarni           │
// │ O'LDIRMAYDI: ular yetim qolib, `npx` bilan ko'tarilgan node          │
// │ jarayonlari fonda ishlab turadi. Ishlab chiqarishda bu asta-sekin     │
// │ o'nlab yetim jarayonga aylanadi.                                     │
// └──────────────────────────────────────────────────────────────────────┘

const tirikJarayonlar = new Set<McpJarayon>()

/** Hozir tirik deb hisoblanadigan MCP jarayonlari soni — diagnostika uchun */
export function tirikJarayonlarSoni(): number {
  return tirikJarayonlar.size
}

/**
 * Hamma tirik MCP jarayonini majburan o'ldiradi.
 *
 * `platform-server/src/index.ts` dagi `toxtat()` shuni chaqiradi.
 * SIGTERM'ni KUTMAYDI: jarayon o'chishi oldidan qo'limizda vaqt yo'q,
 * shuning uchun to'g'ridan-to'g'ri SIGKILL.
 */
export function hammaMcpJarayoniniOldir(): void {
  for (const jarayon of tirikJarayonlar) {
    try {
      jarayon.old()
    } catch {
      // allaqachon o'lgan bo'lishi mumkin
    }
  }
  tirikJarayonlar.clear()
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

/** SIGTERM dan keyin SIGKILL gacha beriladigan muddat */
export const OLDIRISH_KUTISH_MS = 2000

/**
 * stderr dan saqlanadigan eng ko'p belgi.
 *
 * Server stderr ga cheksiz log yozishi mumkin (ba'zilari har chaqiruvni
 * yozadi). Uni to'liq saqlash xotira sizmasi bo'lardi, shuning uchun faqat
 * OXIRGI qism qoladi — ulanish xatosini tushuntirish uchun aynan oxirgi
 * satrlar kerak.
 */
const MAKS_STDERR = 4000

export function stdioTransportYarat(
  buyruq: string,
  argumentlar: string[],
  env: Record<string, string> = {},
): McpTransport & { xatoMatni(): string } {
  const jarayon = jarayonYaratuvchi([buyruq, ...argumentlar], env)
  tirikJarayonlar.add(jarayon)
  // Jarayon o'z-o'zidan o'lsa ham reestrdan chiqsin — aks holda `Set` uzoq
  // ishlaydigan serverda o'lik yozuvlar bilan to'lib borardi.
  void jarayon.tugadi.then(
    () => tirikJarayonlar.delete(jarayon),
    () => tirikJarayonlar.delete(jarayon),
  )

  const tinglovchilar = new Set<(x: JsonRpcKelgan) => void>()
  let bufer = ''
  let stderrMatni = ''
  let yopilgan = false

  jarayon.chiqishniTingla((bolak) => {
    bufer += bolak
    // Newline-delimited JSON: har to'liq qator bitta xabar.
    // Oxirgi (tugallanmagan) bo'lak buferda qoladi.
    let nl: number
    while ((nl = bufer.indexOf('\n')) >= 0) {
      const qator = bufer.slice(0, nl).trim()
      bufer = bufer.slice(nl + 1)
      if (!qator) continue

      let xabar: JsonRpcKelgan
      try {
        xabar = JSON.parse(qator) as JsonRpcKelgan
      } catch {
        // JSON bo'lmagan qator — server stdout'ga log yozgan bo'lishi
        // mumkin. Protokolni buzmaydi, o'tkazib yuboramiz.
        continue
      }

      for (const fn of tinglovchilar) {
        try {
          fn(xabar)
        } catch {
          // Tinglovchi xatosi oqimni buzmasin
        }
      }
    }
  })

  jarayon.xatoOqiminiTingla((bolak) => {
    stderrMatni = (stderrMatni + bolak).slice(-MAKS_STDERR)
  })

  return {
    async yubor(xabar) {
      if (yopilgan) throw new Error('MCP transport yopilgan')
      jarayon.yoz(`${JSON.stringify(xabar)}\n`)
    },

    tingla(fn) {
      tinglovchilar.add(fn)
      return () => {
        tinglovchilar.delete(fn)
      }
    },

    /**
     * Jarayonni to'xtatadi: SIGTERM → kutish → SIGKILL.
     *
     * NEGA IKKI QADAM. SIGTERM serverga o'z resurslarini tozalash imkonini
     * beradi (ba'zilari o'z bola jarayonlarini yopadi). Lekin unga
     * javob bermaydigan server ham bor — shuning uchun 2 soniyadan keyin
     * SIGKILL. Faqat SIGKILL bo'lsa server nevara jarayonlarni yetim
     * qoldirishi mumkin; faqat SIGTERM bo'lsa jarayon abadiy turib qolardi.
     */
    async yop() {
      if (yopilgan) return
      yopilgan = true
      tinglovchilar.clear()
      tirikJarayonlar.delete(jarayon)

      try {
        jarayon.toxtat()
      } catch {
        // allaqachon o'lgan bo'lishi mumkin
      }

      const oldirish = setTimeout(() => {
        try {
          jarayon.old()
        } catch {
          // shu payt o'lgan bo'lsa ham mayli
        }
      }, OLDIRISH_KUTISH_MS)
      // Node/Bun'da taymer jarayonni ushlab turmasin
      oldirish.unref?.()

      try {
        await jarayon.tugadi
      } catch {
        // tugash xatosi ham yopishni to'xtatmasin
      } finally {
        clearTimeout(oldirish)
      }
    },

    /** Ulanish xatosini tushuntirish uchun — stderr ning oxirgi qismi */
    xatoMatni() {
      return stderrMatni.trim()
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP transport (streamable-http va sse)
// ---------------------------------------------------------------------------
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ STDIO'DAN TUB FARQI: OQIM YO'Q, SO'ROV-JAVOB BOR.                    │
// │                                                                      │
// │ stdio'da bitta uzluksiz oqim bor va javoblar `id` bo'yicha            │
// │ moslashtiriladi. HTTP'da esa har `yubor()` — alohida POST va javob   │
// │ AYNAN SHU so'rovning javobi bo'lib qaytadi.                          │
// │                                                                      │
// │ Klient interfeysi bir xil qolishi uchun javobni POST ichida o'qiymiz │
// │ va `tingla()` tinglovchilariga uzatamiz — klient uchun bu stdio'dan  │
// │ farq qilmaydi. Shu tufayli `mcp-klient.ts` ga bitta ham shart        │
// │ qo'shilmadi.                                                         │
// └──────────────────────────────────────────────────────────────────────┘
//
// IKKI VARIANT BITTA SINFDA. `streamable-http` (yangi) va `sse` (eski)
// farqi — javob formati: birinchisi oddiy JSON, ikkinchisi
// `text/event-stream`. Buni `Content-Type` dan aniqlaymiz, ya'ni alohida
// sinf ochish kerak emas. Registry'da ikkala tur ham uchraydi.

/** HTTP so'rovi uchun standart kutish muddati */
export const HTTP_TIMEOUT_MS = 30_000

/**
 * SSE javobidan JSON-RPC xabarlarini ajratadi.
 *
 * Format: `data: {...}` qatorlari, bo'sh qator bilan ajratilgan hodisalar.
 * Bizga faqat `data` kerak — `event`/`id`/`retry` maydonlari MCP'da
 * ishlatilmaydi.
 *
 * Eksport qilingan, chunki alohida test qilinadi (SSE tahlili — xatoga eng
 * moyil joy).
 */
export function sseXabarlariniAjrat(matn: string): JsonRpcKelgan[] {
  const xabarlar: JsonRpcKelgan[] = []
  for (const qator of matn.split('\n')) {
    const tozalangan = qator.trimStart()
    if (!tozalangan.startsWith('data:')) continue
    const mazmun = tozalangan.slice(5).trim()
    if (!mazmun || mazmun === '[DONE]') continue
    try {
      xabarlar.push(JSON.parse(mazmun) as JsonRpcKelgan)
    } catch {
      // JSON bo'lmagan `data` — o'tkazib yuboramiz (stdio bilan bir xil qoida)
    }
  }
  return xabarlar
}

export function httpTransportYarat(
  url: string,
  sarlavhalar: Record<string, string> = {},
  timeoutMs: number = HTTP_TIMEOUT_MS,
): McpTransport & { xatoMatni(): string } {
  const tinglovchilar = new Set<(x: JsonRpcKelgan) => void>()
  let yopilgan = false
  let oxirgiXato = ''
  /**
   * Server bergan sessiya id'si.
   *
   * Spec: server `initialize` javobida `Mcp-Session-Id` sarlavhasini
   * qaytarsa, KEYINGI hamma so'rov shu bilan yuborilishi kerak. Usiz
   * server "sessiya yo'q" deb 400 qaytaradi.
   */
  let sessiyaId: string | undefined

  const tarqat = (xabar: JsonRpcKelgan) => {
    for (const fn of tinglovchilar) {
      try {
        fn(xabar)
      } catch {
        // Tinglovchi xatosi transportni buzmasin
      }
    }
  }

  return {
    async yubor(xabar) {
      if (yopilgan) throw new Error('MCP transport yopilgan')

      const javob = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Ikkala formatni ham qabul qilamiz — server o'zi tanlaydi
          Accept: 'application/json, text/event-stream',
          ...(sessiyaId ? { 'Mcp-Session-Id': sessiyaId } : {}),
          ...sarlavhalar,
        },
        body: JSON.stringify(xabar),
        signal: AbortSignal.timeout(timeoutMs),
      })

      const yangiSessiya = javob.headers.get('Mcp-Session-Id')
      if (yangiSessiya) sessiyaId = yangiSessiya

      if (!javob.ok) {
        // Tana xato sababini o'z ichiga olishi mumkin — diagnostika uchun saqlaymiz
        oxirgiXato = (await javob.text().catch(() => '')).slice(0, 500)
        throw new Error(`MCP HTTP xatosi: ${javob.status} ${javob.statusText}`)
      }

      // Xabarnoma (`id` yo'q) uchun server 202 va bo'sh tana qaytaradi
      if (javob.status === 204 || !javob.body) return

      const turi = javob.headers.get('Content-Type') ?? ''
      const matn = await javob.text()
      if (!matn.trim()) return

      if (turi.includes('text/event-stream')) {
        for (const x of sseXabarlariniAjrat(matn)) tarqat(x)
        return
      }

      try {
        const xom = JSON.parse(matn) as JsonRpcKelgan | JsonRpcKelgan[]
        // Server to'plam (batch) qaytarishi mumkin
        for (const x of Array.isArray(xom) ? xom : [xom]) tarqat(x)
      } catch {
        oxirgiXato = matn.slice(0, 500)
        throw new Error('MCP javobi JSON emas')
      }
    },

    tingla(fn) {
      tinglovchilar.add(fn)
      return () => {
        tinglovchilar.delete(fn)
      }
    },

    /**
     * HTTP'da o'ldiriladigan jarayon yo'q — faqat tinglovchilarni tozalaymiz
     * va yangi so'rovlarni to'xtatamiz.
     */
    async yop() {
      yopilgan = true
      tinglovchilar.clear()
    },

    xatoMatni() {
      return oxirgiXato.trim()
    },
  }
}
