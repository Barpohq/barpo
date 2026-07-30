// Suhbat konteksti — LLM'ga nima yuborilishini hal qiladi.
//
// Ikki muammoni yechadi:
//
// 1) TOOL NATIJALARI SAQLANISHI. Ilgari tarix `{role, text}` juftliklaridan
//    iborat edi, ya'ni tool natijalari (o'qilgan fayl, bash chiqishi) LLM'ga
//    qaytmasdi. Agent har turn xotirasini yo'qotardi: "package.json ni o'qi"
//    dan keyin "versiyani ayt" desangiz, faylni qayta o'qishga majbur edi.
//    Endi `AgentMessage[]` xom holda saqlanadi va qaytariladi.
//
// 2) KONTEKST CHEKSIZ O'SMASLIGI. Uzun suhbat context window'ga sig'may
//    qoladi va sessiya butunlay ishlamay qo'yadi. Ikki bosqichli himoya:
//    avval `siqishKerakmi()` → LLM bilan summary (`siq()`), agar u ham
//    yetmasa yoki o'chirilgan bo'lsa — eng eski xabarlarni tashlash.
//
// pi'dan farq: pi sessiyani JSONL daraxt sifatida saqlaydi va compaction
// entry qo'shadi. Bizda esa sessiya SQLite'da, har xabar bitta qator. Shu
// sababli `pi-agent-core` ning `Session`/`SessionStorage` qatlamini emas,
// faqat sof funksiyalarini (`estimateContextTokens`, `generateSummary`)
// ishlatamiz — ular saqlash usulidan mustaqil.

import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
} from '@earendil-works/pi-agent-core/node'
import type { AgentMessage } from '@earendil-works/pi-agent-core/node'
import type { Api, Model, Models } from '@earendil-works/pi-ai'

/** Xabarga biriktirilgan fayl — agentga faqat yo'li ko'rsatiladi */
export interface XabarBiriktirmasi {
  tur: 'rasm' | 'fayl'
  /** Foydalanuvchi bergan nom — eslatmada shu ko'rinadi */
  aslNom: string
  /** Ish papkasiga nisbatan yo'l — agent `read` ga shuni beradi */
  yol: string
}

/** Bitta saqlangan xabar — bazadan kelgan shaklda */
export interface SaqlanganXabar {
  role: 'user' | 'assistant'
  /** UI ko'rsatadigan matn — `agentMessages` bo'lmasa zaxira sifatida ishlatiladi */
  text: string
  /** LLM ko'radigan to'liq kontekst; eski xabarlarda yo'q */
  agentMessages?: unknown[]
  /**
   * Shu xabarga biriktirilgan fayllar.
   *
   * Kontekstga TUSHMAYDI (`kontekstniQur` ularni ko'rmaydi) — faqat
   * `prompt()` matniga eslatma bo'lib qo'shiladi (`agent.ts`:
   * `biriktirmaEslatmasi`). Sabab: eslatma `chat_messages.text` ga
   * yozilmasligi kerak, aks holda fayl nomi klassifikator tarixiga tushardi.
   */
  biriktirmalar?: XabarBiriktirmasi[]
}

export interface SiqishSozlamalari {
  /** Siqish umuman yoqilganmi */
  yoqilgan: boolean
  /** Summary prompti va javob uchun ajratilgan token zaxirasi */
  zaxiraTokenlar: number
  /** Siqishdan keyin o'zgarishsiz qoladigan eng yangi kontekst hajmi */
  saqlanadiganTokenlar: number
}

/** Tarixdagi eng ko'p xabar soni — siqishdan keyin ham qo'llanadigan qattiq chegara */
export interface TarixSozlamalari {
  maksXabar: number
  /** Bitta tool natijasining tarixdagi eng katta uzunligi (belgi) */
  toolNatijasiChegarasi: number
}

// ---------------------------------------------------------------------------
// Saqlangan xabarlardan LLM konteksti qurish
// ---------------------------------------------------------------------------

/**
 * Bazadagi xabarlardan `AgentMessage[]` quradi.
 *
 * `agentMessages` bor xabar — xom holda qo'shiladi (tool natijalari bilan).
 * Yo'q bo'lsa (eski xabarlar yoki tool'siz suhbat) `text` dan oddiy xabar
 * yasaladi. Ikkalasi aralash bo'lishi mumkin va bu normal: migratsiyadan
 * oldingi suhbat davom ettirilsa, eski qismi matn, yangi qismi to'liq.
 */
export function kontekstniQur(xabarlar: SaqlanganXabar[]): AgentMessage[] {
  const natija: AgentMessage[] = []
  const vaqt = Date.now()

  for (const x of xabarlar) {
    if (x.agentMessages?.length) {
      // Xom JSON — tipni ishonch bilan tiklaymiz, chunki uni o'zimiz yozganmiz.
      // Buzuq bo'lsa provider so'rovi xato beradi va oqim `xato` bilan tugaydi;
      // bu jimgina noto'g'ri kontekstdan yaxshiroq.
      natija.push(...(x.agentMessages as AgentMessage[]))
      continue
    }
    if (!x.text.trim()) continue
    natija.push(
      x.role === 'user'
        ? { role: 'user', content: x.text, timestamp: vaqt }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: x.text }],
            api: 'openai-completions',
            provider: 'tarix',
            model: 'tarix',
            usage: bosSarflov(),
            stopReason: 'stop',
            timestamp: vaqt,
          },
    )
  }

  return natija
}

function bosSarflov() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

// ---------------------------------------------------------------------------
// Tool natijalarini qisqartirish
// ---------------------------------------------------------------------------

/**
 * Tarixga saqlanadigan tool natijalarini qisqartiradi.
 *
 * Nega kerak: bitta `read` 50 000 belgilik fayl qaytarishi mumkin. U tarixda
 * qolsa keyingi har bir so'rovda qayta yuboriladi va kontekstni tez to'ldiradi.
 * Agentga odatda faylning o'sha paytdagi mazmuni kerak edi, keyingi turn'da
 * esa xulosasi yetarli — kerak bo'lsa qayta o'qiy oladi.
 *
 * Qisqartirilgani AYTILADI, jimgina kesilmaydi: agent natija to'liq emasligini
 * bilishi kerak, aks holda "faylda shu bor ekan" deb noto'g'ri xulosa chiqaradi.
 */
export function toolNatijalariniQisqart(
  xabarlar: AgentMessage[],
  chegara: number,
): AgentMessage[] {
  return xabarlar.map((x) => {
    if (x.role !== 'toolResult') return x
    const mazmun = (x as { content?: unknown }).content
    if (!Array.isArray(mazmun)) return x

    let ozgardi = false
    const yangi = mazmun.map((bolak) => {
      const b = bolak as { type?: string; text?: string }
      if (b?.type !== 'text' || typeof b.text !== 'string' || b.text.length <= chegara) {
        return bolak
      }
      ozgardi = true
      const qolgan = b.text.length - chegara
      return {
        ...b,
        text: `${b.text.slice(0, chegara)}\n… (${qolgan} characters truncated from history — read it again if you need it)`,
      }
    })

    return ozgardi ? ({ ...x, content: yangi } as AgentMessage) : x
  })
}

// ---------------------------------------------------------------------------
// Siqish qarori
// ---------------------------------------------------------------------------

/**
 * Kontekst siqish kerakmi.
 *
 * `contextWindow - zaxira` dan oshsa — ha. Zaxira summary prompti va javobga
 * kerak: siqish o'zi LLM chaqiruvi, unga ham joy qolishi shart.
 *
 * Token soni provider bergan `usage` dan olinadi (aniq), u yo'q bo'lsa
 * belgilar soniga qarab taxmin qilinadi (`estimateContextTokens` shu ikkalasini
 * birlashtiradi).
 */
export function siqishKerakmi(
  xabarlar: AgentMessage[],
  contextWindow: number,
  sozlama: SiqishSozlamalari,
): boolean {
  if (!sozlama.yoqilgan) return false
  if (contextWindow <= 0) return false
  const chegara = contextWindow - sozlama.zaxiraTokenlar
  if (chegara <= 0) return false
  return kontekstTokenlari(xabarlar) > chegara
}

/** Kontekstning taxminiy token hajmi */
export function kontekstTokenlari(xabarlar: AgentMessage[]): number {
  if (xabarlar.length === 0) return 0
  return estimateContextTokens(xabarlar).tokens
}

/**
 * Siqishda saqlanadigan eng yangi xabarlar chegarasini topadi.
 *
 * Oxiridan orqaga yurib `saqlanadiganTokenlar` to'lguncha xabar yig'amiz.
 * Muhim qoida: **`toolResult` xabaridan kesib bo'lmaydi** — u o'zini
 * chaqirgan assistant xabari bilan birga qolishi shart, aks holda providerga
 * "javobi bor, savoli yo'q" kontekst boradi va so'rov rad etiladi.
 */
export function kesishNuqtasi(xabarlar: AgentMessage[], saqlanadiganTokenlar: number): number {
  let jami = 0
  let nuqta = xabarlar.length

  for (let i = xabarlar.length - 1; i >= 0; i -= 1) {
    const x = xabarlar[i]!
    jami += taxminiyTokenlar(x)
    if (jami > saqlanadiganTokenlar) break
    nuqta = i
  }

  // `toolResult` dan boshlanmasin — orqaga surib, uni chaqirgan
  // assistant xabarini ham qamrab olamiz
  while (nuqta < xabarlar.length && xabarlar[nuqta]?.role === 'toolResult') {
    nuqta -= 1
    if (nuqta < 0) return 0
  }

  return Math.max(0, nuqta)
}

/**
 * Bitta xabarning taxminiy token hajmi.
 *
 * `pi-agent-core` ning hisoblagichi ishlatiladi, `JSON.stringify(...).length / 4`
 * EMAS. Farq rasmli xabarda halokatli: `JSON.stringify` base64 ni to'liq
 * sanaydi, ya'ni 5 MB rasm ~1.7 million "token" bo'lib chiqardi. U holda
 * `kesishNuqtasi` bitta rasmli xabarni ham `saqlanadiganTokenlar` ga
 * sig'dirmay, siqishda YAQIN TARIX butunlay xulosaga ketardi.
 *
 * pi esa rasmni fiksirlangan ~1200 token deb hisoblaydi
 * (`ESTIMATED_IMAGE_CHARS = 4800`) — bu haqiqatga yaqin, chunki provider
 * ham rasmni piksel o'lchamiga qarab sanaydi, base64 uzunligiga emas.
 *
 * Rasm bu yerga `read` tool'i orqali keladi (biriktirilgan rasm faylini
 * o'qiganda), ya'ni holat nazariy emas.
 */
function taxminiyTokenlar(xabar: AgentMessage): number {
  return estimateTokens(xabar)
}

// ---------------------------------------------------------------------------
// Siqish
// ---------------------------------------------------------------------------

export type SiqishNatijasi =
  | { holat: 'siqildi'; xabarlar: AgentMessage[]; xulosa: string; oldingiTokenlar: number }
  | { holat: 'kerak_emas' }
  | { holat: 'nosoz'; sabab: string }

/**
 * Kontekstni siqadi: eski qismini LLM bilan xulosalab, yangi qismini
 * o'zgarishsiz qoldiradi.
 *
 * Xato tashlamaydi — muammo `nosoz` bo'lib qaytadi va chaqiruvchi qattiq
 * kesishga (`eskilarniTashla`) o'tadi. Sabab: siqish ishlamagani suhbatni
 * to'xtatish uchun asos emas, zaxira yo'l bor.
 */
export async function siq(
  xabarlar: AgentMessage[],
  models: Models,
  model: Model<Api>,
  sozlama: SiqishSozlamalari,
  signal?: AbortSignal,
): Promise<SiqishNatijasi> {
  if (!sozlama.yoqilgan) return { holat: 'kerak_emas' }

  const nuqta = kesishNuqtasi(xabarlar, sozlama.saqlanadiganTokenlar)
  // Kesiladigan qism juda kichik bo'lsa siqishdan foyda yo'q — LLM chaqiruvi
  // o'zi token sarflaydi va vaqt oladi
  if (nuqta <= 1) return { holat: 'kerak_emas' }

  const siqiladigan = xabarlar.slice(0, nuqta)
  const saqlanadigan = xabarlar.slice(nuqta)
  const oldingiTokenlar = kontekstTokenlari(xabarlar)

  // Oldingi siqish xulosasi bor bo'lsa uni topamiz — yangi xulosa unga
  // qo'shimcha bo'ladi, ya'ni eski kontekst butunlay yo'qolmaydi
  const oldingiXulosa = xulosaniAjrat(siqiladigan)

  let natija: Awaited<ReturnType<typeof generateSummary>>
  try {
    natija = await generateSummary(
      siqiladigan,
      models,
      model,
      sozlama.zaxiraTokenlar,
      signal,
      undefined,
      oldingiXulosa,
    )
  } catch (xato) {
    return { holat: 'nosoz', sabab: xatoMatni(xato) }
  }

  if (!natija.ok) {
    return { holat: 'nosoz', sabab: natija.error.message }
  }

  const xulosa = natija.value
  return {
    holat: 'siqildi',
    xabarlar: [xulosaXabari(xulosa), ...saqlanadigan],
    xulosa,
    oldingiTokenlar,
  }
}

/**
 * Xulosani suhbat xabari sifatida o'raydi.
 *
 * `user` roli tanlandi, `assistant` emas: xulosa — agentga berilayotgan
 * kontekst, uning o'z gapi emas. Assistant roli bilan qo'yilsa model uni
 * "men shunday degan edim" deb qabul qiladi va xulosadagi rejalarni
 * bajarilgan deb hisoblashi mumkin.
 */
function xulosaXabari(xulosa: string): AgentMessage {
  return {
    role: 'user',
    content: `${COMPACTION_SUMMARY_PREFIX}${xulosa}${COMPACTION_SUMMARY_SUFFIX}`,
    timestamp: Date.now(),
  } as AgentMessage
}

/** Xabarlar ichidan oldingi siqish xulosasini topadi */
function xulosaniAjrat(xabarlar: AgentMessage[]): string | undefined {
  for (let i = xabarlar.length - 1; i >= 0; i -= 1) {
    const x = xabarlar[i]
    if (x?.role !== 'user' || typeof x.content !== 'string') continue
    if (!x.content.startsWith(COMPACTION_SUMMARY_PREFIX)) continue
    return x.content.slice(
      COMPACTION_SUMMARY_PREFIX.length,
      x.content.length - COMPACTION_SUMMARY_SUFFIX.length,
    )
  }
  return undefined
}

/**
 * Qattiq chegara: eng eski xabarlarni tashlaydi.
 *
 * Bu ZAXIRA yo'l — siqish o'chirilgan yoki ishlamagan holat uchun. Xulosasiz
 * kesish kontekstni yo'qotadi, lekin sessiya ishlashda davom etadi. Alternativa
 * — so'rov context window xatosi bilan yiqilishi, ya'ni suhbat butunlay
 * to'xtashi.
 *
 * `toolResult` dan boshlanmaslik qoidasi bu yerda ham amal qiladi.
 */
export function eskilarniTashla(xabarlar: AgentMessage[], maksXabar: number): AgentMessage[] {
  if (xabarlar.length <= maksXabar) return xabarlar

  let boshi = xabarlar.length - maksXabar
  while (boshi < xabarlar.length && xabarlar[boshi]?.role === 'toolResult') boshi += 1
  return xabarlar.slice(boshi)
}

function xatoMatni(xato: unknown): string {
  return xato instanceof Error ? xato.message : String(xato)
}
