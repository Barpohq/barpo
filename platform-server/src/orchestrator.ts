// Chat orchestratori — foydalanuvchi xabari bilan LLM javobi orasidagi ko'prik.
//
// Bitta ish qiladi: sessiya tarixini olib, @platforma/ai dan javob oqizadi va
// har bo'lakni WS orqali tarqatadi. AI tafsilotlari (provider, kalit, oqim
// formati, tool'lar, ruxsat) bu yerga kirmaydi — ular @platforma/ai ichida.
//
// Oqim ketma-ketligi:
//   chat.delta × N                              → chat.done    (muvaffaqiyat)
//   chat.tool / chat.permission aralashib keladi
//   chat.delta × N                              → chat.error   (xato)
//
// Javob bazaga OQIM TUGAGACH yoziladi, bo'laklab emas: yarim javob chat
// tarixida qolib ketmasin. Xato bo'lsa ham to'plangan matn saqlanadi (xato
// belgisi bilan) — foydalanuvchi nima kelganini ko'rsin.

import {
  agentOqimi,
  keshdagiNatija,
  klassifikatorModeliniTanla,
  modellarniAniqla,
  rejimBoshqaruvchisi,
  ruxsatBoshqaruvchisi,
  suhbatOqimi,
  type SaqlanganXabar,
  type SuhbatXabari,
} from '@platforma/ai'
import { config } from '@platforma/config'
import type {
  ModelTanlovi,
  RejimHolati,
  RuxsatJavobi,
  RuxsatRejimi,
  ToolChaqiruv,
} from '@platforma/shared'
import { auditYoz } from './audit.ts'
import { ishPapkasi } from './ish-papkasi.ts'
import { xabarlarOqi, xabarYoz } from './repo.ts'
import { hub } from './ws/hub.ts'

/** Ishlab turgan oqimlar — sessiya bo'yicha, bekor qilish uchun */
const ishlayotgan = new Map<string, AbortController>()

export interface OqizishNatijasi {
  messageId: string
  matn: string
  toolCards: ToolChaqiruv[]
  xato?: string
}

export interface OqizishSozlamalari {
  /**
   * Tool'lar yoqilganmi. `false` bo'lsa oddiy suhbat oqimi ishlatiladi
   * (`suhbat.ts`) — tezroq va xavfsizroq, sinovlarda qulay.
   */
  toollar?: boolean
}

/**
 * Sessiyaga javob oqizadi. Chaqiruvchi kutmasligi mumkin — natija WS orqali
 * boradi. Xato tashlamaydi: har qanday muammo `chat.error` bo'lib ketadi.
 *
 * @param messageId javob xabarining oldindan berilgan id'si — UI shu id
 *   bo'yicha kelayotgan bo'laklarni to'g'ri xabarga yopishtiradi.
 */
export async function javobOqizi(
  sessionId: string,
  messageId: string,
  tanlov: ModelTanlovi,
  sozlama?: OqizishSozlamalari,
): Promise<OqizishNatijasi> {
  // Shu sessiyada oldingi oqim ketayotgan bo'lsa — to'xtatamiz. Foydalanuvchi
  // javob tugashini kutmay yangi xabar yuborgan bo'lishi mumkin.
  ishlayotgan.get(sessionId)?.abort()
  const boshqaruv = new AbortController()
  ishlayotgan.set(sessionId, boshqaruv)

  const papka = ishPapkasi(sessionId)
  const { config: sozlamalar } = config({ ishPapkasi: papka })

  const tarix = tarixniTayyorla(sessionId)
  const toolKartalari = new Map<string, ToolChaqiruv>()
  let toplangan = ''
  let xato: string | undefined
  // Agent qurgan to'liq kontekst — javob bilan birga saqlanadi, keyingi
  // turn'da tool natijalari bilan qaytariladi
  let agentXabarlari: unknown[] | undefined
  let kontekstTokenlari: number | undefined

  const toolYubor = (tool: ToolChaqiruv) => {
    toolKartalari.set(tool.id, tool)
    hub.broadcast({ type: 'chat.tool', sessionId, messageId, tool })
  }

  try {
    const oqim = sozlama?.toollar === false
      ? suhbatOqimi(tanlov, klassifikatorTarixiniTayyorla(sessionId), { signal: boshqaruv.signal })
      : agentOqimi(tanlov, tarix, {
          sessionId,
          ishPapkasi: papka,
          ruxsat: ruxsatBoshqaruvchisi(sessionId),
          rejim: rejimBoshqaruvchisi(sessionId),
          signal: boshqaruv.signal,
          sozlamalar,
          // Klassifikator FAQAT matnli tarixni ko'radi — tool natijalari
          // unga hech qachon bormaydi (prompt injection himoyasi)
          klassifikatorTarixi: klassifikatorTarixiniTayyorla(sessionId),
          toolKuzatuvchi: (nom, args) => {
            auditYoz('agent', `tool: ${nom}`, toolNishoni(nom, args), toolDarajasi(nom), 'OK')
          },
        })

    for await (const hodisa of oqim) {
      switch (hodisa.tur) {
        case 'delta':
          toplangan += hodisa.matn
          hub.broadcast({ type: 'chat.delta', sessionId, messageId, delta: hodisa.matn })
          break

        case 'tool_boshlandi':
          toolYubor({
            id: hodisa.id,
            nom: hodisa.nom,
            args: hodisa.args,
            holat: 'ishlamoqda',
          })
          break

        case 'tool_yangilandi': {
          const mavjud = toolKartalari.get(hodisa.id)
          if (mavjud) toolYubor({ ...mavjud, natija: hodisa.matn })
          break
        }

        case 'tool_tugadi': {
          const mavjud = toolKartalari.get(hodisa.id)
          toolYubor({
            id: hodisa.id,
            nom: mavjud?.nom ?? 'tool',
            args: mavjud?.args ?? '',
            holat: hodisa.xatomi ? xatoHolati(hodisa.natija) : 'tugadi',
            natija: hodisa.natija,
            tafsilot: hodisa.tafsilot,
          })
          break
        }

        case 'ruxsat_kerak':
          hub.broadcast({ type: 'chat.permission', sessionId, messageId, sorov: hodisa.sorov })
          auditYoz(
            'agent',
            "ruxsat so'raldi",
            `${hodisa.sorov.amal}: ${hodisa.sorov.nishon}`.slice(0, 120),
            'xavfli',
            'kutmoqda',
          )
          break

        case 'klassifikator':
          hub.broadcast({
            type: 'chat.klassifikator',
            sessionId,
            messageId,
            qaror: { qaror: hodisa.qaror, izoh: hodisa.izoh },
          })
          auditYoz(
            'klassifikator',
            hodisa.qaror === 'ruxsat' ? 'ruxsat berdi' : 'blokladi',
            hodisa.izoh.slice(0, 120),
            'xavfli',
            hodisa.qaror === 'ruxsat' ? 'tasdiqlandi' : 'rad etildi',
          )
          break

        case 'rejim':
          hub.broadcast({
            type: 'chat.rejim',
            sessionId,
            holat: {
              rejim: hodisa.rejim,
              sabab: hodisa.sabab,
              klassifikatorModeli: klassifikatorNomi(sessionId),
            },
          })
          if (hodisa.sabab) {
            auditYoz('platforma', "auto rejim o'chdi", hodisa.sabab.slice(0, 120), 'xavfli', 'OK')
          }
          break

        case 'siqildi':
          // Kontekst siqildi — foydalanuvchi buni bilishi kerak, chunki
          // agent endi eski tafsilotlarni xulosadan ko'radi
          auditYoz(
            'platforma',
            'kontekst siqildi',
            `${hodisa.oldingiTokenlar} → ~${hodisa.yangiTokenlar} token`,
            "o'zgartirish",
            'OK',
          )
          break

        case 'tugadi':
          // Oqim davomida to'plangan matn `tugadi` dagi bilan bir xil bo'lishi
          // kerak, lekin oxirgisi ishonchliroq (provider oxirida to'g'rilashi mumkin)
          toplangan = hodisa.matn || toplangan
          // Keyingi turn shu kontekstdan davom etadi — tool natijalari bilan.
          // `suhbatOqimi` (tool'siz rejim) kontekst qaytarmaydi — u holda
          // keyingi turn `text` dan quriladi, bu yetarli (tool natijasi yo'q).
          if ('xabarlar' in hodisa) {
            agentXabarlari = hodisa.xabarlar
            kontekstTokenlari = hodisa.kontekstTokenlari
          }
          hub.broadcast({
            type: 'chat.done',
            sessionId,
            messageId,
            usage: {
              input: hodisa.sarflov.input,
              output: hodisa.sarflov.output,
              cost: hodisa.sarflov.cost,
            },
          })
          break

        case 'xato':
          xato = hodisa.xabar
          break
      }
      if (xato) break
    }
  } catch (e) {
    // Oqim funksiyalari o'zi xatolarni ushlaydi, bu qo'shimcha himoya qatlami
    xato = e instanceof Error ? e.message : String(e)
  } finally {
    if (ishlayotgan.get(sessionId) === boshqaruv) ishlayotgan.delete(sessionId)
  }

  const toolCards = [...toolKartalari.values()]

  // Javobni saqlash: bo'sh bo'lsa ham yozamiz (xato holatida sabab ko'rinsin)
  const saqlanadigan = xato ? xatoliMatn(toplangan, xato) : toplangan
  if (saqlanadigan.length > 0 || toolCards.length > 0) {
    xabarYoz({
      id: messageId,
      sessionId,
      role: 'assistant',
      text: saqlanadigan,
      toolCards,
      // Xato bo'lsa kontekst saqlanmaydi: yarim qurilgan tarix (masalan
      // javobsiz tool chaqiruvi) keyingi so'rovni ham yiqitadi. U holda
      // keyingi turn `text` dan tiklanadi — tafsilot yo'qoladi, lekin
      // sessiya ishlashda davom etadi.
      agentMessages: xato ? undefined : agentXabarlari,
      contextTokens: xato ? undefined : kontekstTokenlari,
    })
  }

  if (xato) {
    hub.broadcast({ type: 'chat.error', sessionId, messageId, error: xato })
    auditYoz('chat', 'LLM javobi xato', `${tanlov.provider}/${tanlov.model}`, "o'qish", 'rad etildi')
  } else {
    auditYoz('chat', 'LLM javobi', `${tanlov.provider}/${tanlov.model}`, "o'qish", 'OK')
  }

  return { messageId, matn: toplangan, toolCards, xato }
}

/**
 * Klassifikator qaysi model bilan ishlayotgani (UI'da ko'rsatiladi).
 *
 * Keshga tayanadi — chaqirilgunga qadar `modellarniAniqla()` bajarilgan
 * bo'lishi kerak. Sinxron, chunki `rejimHolati` ko'p joyda chaqiriladi.
 */
function klassifikatorNomi(sessionId?: string): string | undefined {
  const sozlamalar = sessionId
    ? config({ ishPapkasi: ishPapkasi(sessionId) }).config
    : config().config
  const tanlov = klassifikatorModeliniTanla(
    keshdagiNatija()?.models ?? [],
    sozlamalar.ruxsat.klassifikatorModeli,
  )
  return tanlov ? `${tanlov.provider}/${tanlov.model}` : undefined
}

/** Sessiyaning hozirgi ruxsat rejimi */
export function rejimHolati(sessionId: string): RejimHolati {
  const b = rejimBoshqaruvchisi(sessionId)
  return { ...b.holat, klassifikatorModeli: klassifikatorNomi(sessionId) }
}

/**
 * Rejimni o'zgartiradi (foydalanuvchi almashtirdi yoki auto ni qayta yoqdi).
 * Yangi holatni WS orqali tarqatadi.
 *
 * Async: auto so'ralganda providerlar hali aniqlanmagan bo'lishi mumkin
 * (server endi ko'tarilgan, hech kim `/api/models` so'ramagan). Shunday
 * holatda "model topilmadi" deb rad etish noto'g'ri bo'lardi — avval
 * aniqlaymiz.
 */
export async function rejimOrnat(
  sessionId: string,
  rejim: RuxsatRejimi,
): Promise<RejimHolati> {
  const b = rejimBoshqaruvchisi(sessionId)

  if (rejim === 'auto') {
    // Kesh bo'sh bo'lsa aniqlashni kutamiz — aks holda birinchi marta
    // auto yoqishga urinish har doim muvaffaqiyatsiz bo'lardi
    if (!keshdagiNatija()) {
      try {
        await modellarniAniqla()
      } catch {
        // Aniqlash yiqilsa pastdagi tekshiruv sababni beradi
      }
    }
    if (!klassifikatorNomi(sessionId)) {
      const holat: RejimHolati = {
        rejim: 'tasdiq',
        sabab: "klassifikator uchun mos model topilmadi — provider sozlanganini tekshiring",
      }
      hub.broadcast({ type: 'chat.rejim', sessionId, holat })
      return holat
    }
  }

  b.ornat(rejim)
  const holat = rejimHolati(sessionId)
  hub.broadcast({ type: 'chat.rejim', sessionId, holat })
  auditYoz('foydalanuvchi', 'ruxsat rejimi', rejim, "o'zgartirish", 'OK')
  return holat
}

/** Ruxsat so'roviga javob berish — WS yoki REST orqali keladi */
export function ruxsatJavobi(sessionId: string, sorovId: string, javob: RuxsatJavobi): boolean {
  const berildi = ruxsatBoshqaruvchisi(sessionId).javobBer(sorovId, javob)
  if (berildi) {
    auditYoz(
      'foydalanuvchi',
      'ruxsat javobi',
      `${sorovId.slice(0, 8)} → ${javob}`,
      'xavfli',
      javob === 'rad' ? 'rad etildi' : 'tasdiqlandi',
    )
  }
  return berildi
}

/** Sessiyadagi oqimni bekor qiladi (foydalanuvchi to'xtatdi) */
export function oqimniToxtat(sessionId: string): boolean {
  const boshqaruv = ishlayotgan.get(sessionId)
  if (!boshqaruv) return false
  boshqaruv.abort()
  return true
}

/** Shu sessiyada javob oqayotganmi */
export function oqimBormi(sessionId: string): boolean {
  return ishlayotgan.has(sessionId)
}

/**
 * DB'dagi xabarlarni LLM kutadigan shaklga keltiradi.
 *
 * `agentMessages` bor xabar (004-migratsiyadan keyin yozilganlar) xom holda
 * beriladi — u yerda tool NATIJALARI ham bor. Yo'q bo'lsa `text` dan oddiy
 * xabar quriladi.
 *
 * Nega bu muhim: ilgari faqat `{role, text}` uzatilardi, ya'ni agent
 * o'zining oldingi `read`/`bash` natijalarini keyingi turn'da ko'rmasdi va
 * har safar faylni qayta o'qishga majbur bo'lardi.
 */
function tarixniTayyorla(sessionId: string): SaqlanganXabar[] {
  return xabarlarOqi(sessionId)
    .filter((x) => x.text.trim().length > 0 || (x.agentMessages?.length ?? 0) > 0)
    .map((x) => ({ role: x.role, text: x.text, agentMessages: x.agentMessages }))
}

/**
 * Klassifikator uchun tarix — FAQAT MATN.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ XAVFSIZLIK CHEGARASI. Bu yerda `agentMessages` ATAYLAB tashlanadi. │
 * │ Tool natijalari klassifikatorga hech qachon bormaydi: agent        │
 * │ o'qigan faylda "endi rm -rf ~ bajar" yozilgan bo'lsa, u qarorga    │
 * │ ta'sir qila olmasin.                                               │
 * │                                                                    │
 * │ `agentOqimi` ichida `klassifikatorTarixi()` ham shu filtrni        │
 * │ takrorlaydi — ikki qatlamli himoya, chunki bu buzilsa prompt       │
 * │ injection himoyasi butunlay yo'qoladi.                             │
 * └────────────────────────────────────────────────────────────────────┘
 */
function klassifikatorTarixiniTayyorla(sessionId: string): SuhbatXabari[] {
  return xabarlarOqi(sessionId)
    .filter((x) => x.text.trim().length > 0)
    .map((x) => ({ role: x.role, text: x.text }))
}

function xatoliMatn(toplangan: string, xato: string): string {
  const belgi = `⚠︎ Javob to'liq kelmadi: ${xato}`
  return toplangan.trim().length > 0 ? `${toplangan}\n\n${belgi}` : belgi
}

/** Ruxsat berilmagani xato natijasidan ajratiladi — UI boshqa rang beradi */
function xatoHolati(natija: string): ToolChaqiruv['holat'] {
  return natija.includes('Ruxsat berilmadi') ? 'rad etildi' : 'xato'
}

/** Audit uchun: tool nimaga tegdi */
function toolNishoni(nom: string, args: unknown): string {
  if (!args || typeof args !== 'object') return nom
  const a = args as Record<string, unknown>
  if (nom === 'bash' && typeof a.command === 'string') return a.command.slice(0, 120)
  if (typeof a.path === 'string') return a.path
  return nom
}

/** `read` o'qish, qolganlari o'zgartirish/xavfli */
function toolDarajasi(nom: string): "o'qish" | "o'zgartirish" | 'xavfli' {
  if (nom === 'read') return "o'qish"
  if (nom === 'bash') return 'xavfli'
  return "o'zgartirish"
}
