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
  XOTIRA_PAPKASI,
  type SaqlanganXabar,
  type SuhbatXabari,
} from '@platforma/ai'
import { config } from '@platforma/config'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ModelTanlovi,
  OqimHolati,
  RejimHolati,
  RuxsatJavobi,
  RuxsatRejimi,
  RuxsatSorovi,
  ToolChaqiruv,
} from '@platforma/shared'
import { auditYoz } from './audit.ts'
import { sessiyaIshPapkasi } from './ish-papkasi.ts'
import {
  faolSkilllar,
  serverlarOqi,
  sessiyaLoyihaPapkasi,
  sessiyaOqi,
  toolChaqiruvYoz,
  xabarlarOqi,
  xabarYoz,
} from './repo.ts'
import { loyihagaSinxronla } from './skill-ombor.ts'
import { hub } from './ws/hub.ts'

/**
 * Sessiya uchun ish papkasi — loyihaga ulangan bo'lsa loyiha papkasi.
 *
 * Papka tanlovi HAR CHAQIRUVDA bazadan o'qiladi (keshlanmaydi): sessiya
 * yaratilgach loyihasi o'zgarmaydi, lekin kesh xotirada eskirib qolish
 * xavfini olib kelardi va bu bitta indeksli SELECT.
 *
 * Papka `ChegaralanganMuhit` ga `ishPapkasi` bo'lib boradi, ya'ni chegara
 * tekshiruvi loyiha papkasiga xuddi sessiya papkasidagidek qo'llanadi:
 * ichkarida — o'tadi, tashqarida — ruxsat so'raladi. Loyiha papkasi uchun
 * hech qanday imtiyoz yo'q.
 */
function sessiyaPapkasi(sessionId: string): string {
  return sessiyaIshPapkasi(sessionId, sessiyaLoyihaPapkasi(sessionId))
}

/**
 * Sessiyada faol skilllarni ish papkasiga nusxalaydi.
 *
 * Faol = global o'rnatilganlar + shu sessiya loyihasiga o'rnatilganlar.
 * Loyihasiz sessiyada faqat global (`projectId: null`).
 *
 * XATO TASHLAMAYDI: skill tayyorlanmasa suhbat baribir boshlanadi, faqat
 * `<available_skills>` ro'yxati bo'sh bo'ladi. Bu qatlam qulaylik uchun —
 * uning nosozligi butun sessiyani yiqitmasligi kerak.
 */
function skilllarniTayyorla(sessionId: string, papka: string): void {
  try {
    const sessiya = sessiyaOqi(sessionId)
    loyihagaSinxronla(papka, faolSkilllar(sessiya?.projectId ?? null))
  } catch {
    // jim o'tamiz — sabab yuqoridagi izohda
  }
}

/**
 * Xotira papkasini yaratadi (`.platforma/memory/`).
 *
 * Skilllardan MUHIM FARQ: bu papka SINXRONLANMAYDI. Skilllarning haqiqat
 * manbai baza va ortiqcha papka o'chiriladi; xotirani esa agentning o'zi
 * yozadi va uni hech kim o'chirmaydi. Bu yerda faqat papka MAVJUDLIGI
 * kafolatlanadi.
 *
 * Nega oldindan yaratamiz: `write` tool'i yo'q papkaga yozganda uni o'zi
 * yaratadi, lekin bo'sh papkani `xotiralarniOqi` o'qiy olmasa promptga
 * "hozircha xotira yo'q" tushadi va agent birinchi faylni yozishga
 * urinadi — o'sha payt papka bo'lmasa ham ish bitadi. Ya'ni bu qat'iy shart
 * emas, lekin papka borligi diskda tuzilmani ko'rinarli qiladi va agent
 * `ls` bilan tekshirganda bo'sh papkani ko'radi.
 *
 * XATO TASHLAMAYDI — skilllardagi bilan bir xil qoida.
 */
function xotiraniTayyorla(papka: string): void {
  try {
    mkdirSync(join(papka, XOTIRA_PAPKASI), { recursive: true })
  } catch {
    // jim o'tamiz — xotirasiz ham suhbat to'liq ishlaydi
  }
}

/**
 * Ishlab turgan oqim haqidagi ma'lumot.
 *
 * `holat` faqat ikki qiymatni oladi — oqim tugagach yozuv Map'dan butunlay
 * chiqariladi, ya'ni 'tugadi'/'xato' bu yerda hech qachon saqlanmaydi.
 */
interface IshlayotganOqim {
  boshqaruv: AbortController
  holat: 'ishlayapti' | 'ruxsat-kutmoqda'
}

/** Ishlab turgan oqimlar — sessiya bo'yicha, bekor qilish va ko'rsatish uchun */
const ishlayotgan = new Map<string, IshlayotganOqim>()

/** Ishlayotgan bitta sessiyaning tashqariga ko'rinadigan tavsifi */
export interface IshlayotganSessiya {
  sessionId: string
  holat: 'ishlayapti' | 'ruxsat-kutmoqda'
}

/**
 * Hozir oqim ketayotgan sessiyalar ro'yxati.
 *
 * UI sahifa ochilganda boshlang'ich holatni shu yerdan oladi (GET
 * /api/chat/running), keyin `chat.status` eventlari bilan yangilab boradi:
 * WS ulanishi sahifa ochilishidan keyin ulanadi, ya'ni undan oldingi
 * holat o'zgarishlari yo'qolgan bo'lishi mumkin.
 */
export function ishlayotganSessiyalar(): IshlayotganSessiya[] {
  return [...ishlayotgan.entries()].map(([sessionId, oqim]) => ({
    sessionId,
    holat: oqim.holat,
  }))
}

/**
 * Sessiya oqimining holatini yangilaydi va WS orqali tarqatadi.
 *
 * 'tugadi'/'xato' — yakuniy holatlar, ular Map'ga yozilmaydi (yozuv allaqachon
 * `finally` da o'chirilgan bo'ladi), faqat tarqatiladi.
 */
function holatTarqat(sessionId: string, holat: OqimHolati): void {
  const oqim = ishlayotgan.get(sessionId)
  if (oqim && (holat === 'ishlayapti' || holat === 'ruxsat-kutmoqda')) {
    oqim.holat = holat
  }
  hub.broadcast({ type: 'chat.status', sessionId, holat })
}

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
  ishlayotgan.get(sessionId)?.boshqaruv.abort()
  const boshqaruv = new AbortController()
  ishlayotgan.set(sessionId, { boshqaruv, holat: 'ishlayapti' })
  // Oqim boshlandi — sidebar darhol jonli indikatorni ko'rsatadi
  holatTarqat(sessionId, 'ishlayapti')

  // Sessiya loyihaga ulangan bo'lsa tool'lar LOYIHA papkasida ishlaydi —
  // bir loyihaning hamma suhbatlari bitta fayllar to'plamini ko'rsin.
  const papka = sessiyaPapkasi(sessionId)
  const { config: sozlamalar } = config({ ishPapkasi: papka })

  // O'rnatilgan skilllarni ish papkasiga tushiramiz. Har oqim boshida
  // qayta sinxronlanadi: foydalanuvchi suhbat davomida yangi skill
  // o'rnatgan bo'lishi mumkin. Agent ro'yxatni `.platforma/skills/` dan
  // o'zi o'qiydi (`skill-yuklash.ts`).
  skilllarniTayyorla(sessionId, papka)

  // Xotira papkasi — agent o'z yozuvlarini shu yerga qo'yadi. Sinxronlash
  // yo'q, faqat papka mavjudligi kafolatlanadi (`xotiraniTayyorla` ga q.).
  xotiraniTayyorla(papka)

  const tarix = tarixniTayyorla(sessionId)
  const toolKartalari = new Map<string, ToolChaqiruv>()
  let toplangan = ''
  let xato: string | undefined
  // Agent qurgan to'liq kontekst — javob bilan birga saqlanadi, keyingi
  // turn'da tool natijalari bilan qaytariladi
  let agentXabarlari: unknown[] | undefined
  let kontekstTokenlari: number | undefined
  /**
   * Oqim tugaganda ro'yxatdagi yozuv hali ham BIZNIKI edimi.
   *
   * `false` bo'lsa bizni yangi oqim to'xtatgan (foydalanuvchi kutmay yana
   * xabar yubordi) — u holda yakuniy `chat.status` TARQATILMAYDI, aks holda
   * endigina boshlangan yangi oqim UI'da darhol "tugadi" bo'lib ko'rinardi.
   */
  let ozimizniki = true

  /**
   * Hozir bajarilayotgan tool chaqiruvining id'si.
   *
   * Ruxsat so'rovi va uning qarori QAYSI chaqiruvga tegishli ekanini shu
   * bilan bog'laymiz. Bu ishonchli, chunki tool'lar KETMA-KET bajariladi
   * (`agent.ts`: `toolExecution: 'sequential'`) — bir vaqtda faqat bittasi
   * ruxsat kutishi mumkin. Muqobil yo'l (`toolCallId` ni muhit va ruxsat
   * qatlamlaridan o'tkazish) uch faylning interfeysini buzardi.
   */
  let faolTool: string | undefined

  /**
   * So'rov id → qaysi tool chaqiruvi uni so'ragan.
   *
   * `faolTool` YETARLI EMAS. Ruxsat so'rovi javob kelguncha kutadi, ya'ni
   * qaror so'rovdan ANCHA KEYIN keladi va o'sha paytda `faolTool` boshqa
   * chaqiruvni ko'rsatayotgan bo'lishi mumkin. Bir sessiyada ikkita oqim
   * qisqa vaqt yonma-yon yashashi ham mumkin (foydalanuvchi to'xtatib,
   * darhol yangi xabar yubordi) — u holda ruxsat boshqaruvchisi ikkalasiga
   * ham xabar beradi.
   *
   * Shuning uchun `sorovId` bor qaror SHU jadval bo'yicha bog'lanadi va
   * begona so'rov (boshqa oqimniki) JIMGINA TASHLANADI — noto'g'ri kartaga
   * yozilgandan ko'ra yozilmagani yaxshi.
   */
  const sorovningTooli = new Map<string, string>()

  /**
   * Tool chaqiruvini AVVAL bazaga yozadi, KEYIN UI'ga tarqatadi.
   *
   * Tartib muhim: WS eventi yo'qolishi mumkin va oqim o'rtasida uzilishi
   * ham mumkin, bazadagi yozuv esa qoladi. Aks holda (ilgarigidek) uzilgan
   * javobda bajarilgan buyruqlar izsiz yo'qolardi.
   *
   * Baza xatosi oqimni TO'XTATMAYDI: suhbat davom etgani yozuvdan muhimroq
   * va xato holatida ham kamida UI to'g'ri ko'rsatadi.
   */
  const toolYubor = (tool: ToolChaqiruv) => {
    toolKartalari.set(tool.id, tool)
    try {
      toolChaqiruvYoz({ ...tool, sessionId, messageId })
    } catch {
      // jim o'tamiz — sabab yuqoridagi izohda
    }
    hub.broadcast({ type: 'chat.tool', sessionId, messageId, tool })
  }

  /**
   * Mavjud kartani yangilaydi (ruxsat qarori, klassifikator yorlig'i).
   *
   * Karta hali yo'q bo'lsa jim o'tamiz: ruxsat so'raladigan amallarning
   * hammasi tool orqali keladi, ya'ni bunday holat kutilmaydi — lekin
   * kelsa ham oqim buzilmasligi kerak.
   */
  const toolniYangila = (id: string | undefined, ozgarish: Partial<ToolChaqiruv>) => {
    if (!id) return
    const mavjud = toolKartalari.get(id)
    if (!mavjud) return
    toolYubor({ ...mavjud, ...ozgarish })
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
          // `serverList` tool'ining manbai. Funksiya sifatida beriladi —
          // ro'yxat har chaqiruvda bazadan yangi o'qiladi, chunki
          // foydalanuvchi suhbat davomida server qo'shishi/o'chirishi
          // mumkin. Faqat ulanish maydonlari uzatiladi (`id`/`createdAt`
          // agentga kerak emas).
          serverManbasi: () =>
            serverlarOqi().map((s) => ({
              name: s.name,
              host: s.host,
              port: s.port,
              username: s.username,
            })),
          toolKuzatuvchi: (nom, args) => {
            auditYoz('agent', `tool: ${nom}`, toolNishoni(nom, args), toolDarajasi(nom), 'OK')
          },
        })

    for await (const hodisa of oqim) {
      // Ruxsat kutayotgan oqim yana harakatga keldi — demak javob berildi
      // (yoki muddat tugab rad etildi) va agent davom etmoqda. Alohida
      // "ruxsat javob berildi" hodisasi yo'q, shuning uchun har qanday
      // KEYINGI hodisa shu signal bo'lib xizmat qiladi.
      if (
        hodisa.tur !== 'ruxsat_kerak' &&
        ishlayotgan.get(sessionId)?.holat === 'ruxsat-kutmoqda'
      ) {
        holatTarqat(sessionId, 'ishlayapti')
      }

      switch (hodisa.tur) {
        case 'delta':
          toplangan += hodisa.matn
          hub.broadcast({ type: 'chat.delta', sessionId, messageId, delta: hodisa.matn })
          break

        case 'tool_boshlandi':
          // Ruxsat so'rovi shu chaqiruv ichida keladi — qaysi kartaga
          // biriktirishni bilishimiz uchun eslab qolamiz
          faolTool = hodisa.id
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
            // Ruxsat va klassifikator qarorlari chaqiruv O'RTASIDA kelgan —
            // tugash eventi ularni bilmaydi, shuning uchun ko'chirib olamiz
            ruxsat: mavjud?.ruxsat,
            klassifikator: mavjud?.klassifikator,
          })
          if (faolTool === hodisa.id) faolTool = undefined
          break
        }

        case 'ruxsat_kerak':
          // Qaysi chaqiruv so'raganini ESLAB QOLAMIZ: javob keyinroq
          // keladi va o'shanda `faolTool` boshqasini ko'rsatishi mumkin
          if (faolTool) sorovningTooli.set(hodisa.sorov.id, faolTool)
          hub.broadcast({ type: 'chat.permission', sessionId, messageId, sorov: hodisa.sorov })
          // Oqim javob kelguncha to'xtab turadi — sidebar buni sariq badge
          // bilan ajratib ko'rsatadi, chunki bu foydalanuvchi aralashuvini
          // kutayotgan yagona holat.
          holatTarqat(sessionId, 'ruxsat-kutmoqda')
          auditYoz(
            'agent',
            "ruxsat so'raldi",
            `${hodisa.sorov.amal}: ${hodisa.sorov.nishon}`.slice(0, 120),
            'xavfli',
            'kutmoqda',
          )
          break

        case 'ruxsat_qarori': {
          // Amal QANDAY tasdiqdan o'tgani kartaga (va u orqali bazaga)
          // yoziladi: auto klassifikatormi, foydalanuvchi bosdimi, "har
          // doim" naqshi ishladimi, rad etildimi yoki muddat tugadimi.
          // Shusiz "bu buyruq nega bajarildi?" savoliga javob yo'q edi.
          //
          // `sorovId` bor bo'lsa — so'ragan chaqiruvga bog'lanadi (u allaqachon
          // tugagan bo'lishi mumkin). Yo'q bo'lsa (hardoim/auto/taqiq) qaror
          // ayni shu payt ishlayotgan chaqiruv ichida sinxron chiqqan.
          const nishonTool = hodisa.qaror.sorovId
            ? sorovningTooli.get(hodisa.qaror.sorovId)
            : faolTool
          // Begona so'rov (boshqa oqimniki) — jimgina tashlaymiz
          if (hodisa.qaror.sorovId && !nishonTool) break
          toolniYangila(nishonTool, { ruxsat: hodisa.qaror })
          if (hodisa.qaror.sorovId) sorovningTooli.delete(hodisa.qaror.sorovId)
          auditYoz(
            'platforma',
            'ruxsat qarori',
            `${hodisa.qaror.manba}: ${hodisa.qaror.naqsh ?? '—'}`.slice(0, 120),
            'xavfli',
            hodisa.qaror.berildi ? 'tasdiqlandi' : 'rad etildi',
          )
          break
        }

        case 'klassifikator':
          toolniYangila(faolTool, {
            klassifikator: { qaror: hodisa.qaror, izoh: hodisa.izoh },
          })
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
    // Yozuvni faqat U HALI HAM BIZNIKI bo'lsa o'chiramiz. Foydalanuvchi javob
    // tugashini kutmay yangi xabar yuborgan bo'lsa, bizni to'xtatib yangi oqim
    // boshlangan — o'sha yangisining yozuvini o'chirib yuborsak, sessiya
    // "ishlamayapti" bo'lib ko'rinardi.
    ozimizniki = ishlayotgan.get(sessionId)?.boshqaruv === boshqaruv
    if (ozimizniki) ishlayotgan.delete(sessionId)
  }

  const toolCards = [...toolKartalari.values()]

  // Foydalanuvchi o'zi to'xtatgani XATO EMAS. Ilgari abort ham `xato` yo'lidan
  // o'tib, javob matniga "⚠︎ Javob to'liq kelmadi: So'rov bekor qilindi"
  // qo'shilardi — ustiga tool kartasi allaqachon "to'xtatildi" deb turgani
  // uchun bir hodisa ikki marta ogohlantirish sifatida ko'rinardi.
  const toxtatildi = boshqaruv.signal.aborted

  // Javobni saqlash: bo'sh bo'lsa ham yozamiz (xato holatida sabab ko'rinsin)
  const saqlanadigan = xato && !toxtatildi ? xatoliMatn(toplangan, xato) : toplangan
  // Sessiya oqim davomida o'chirilgan bo'lishi mumkin (DELETE /chat/sessions/:id
  // avval `abort()` qiladi, lekin oqim shu nuqtaga baribir yetib keladi).
  // Tekshirmasak `xabarYoz` foreign key xatosi tashlardi — u esa bu yerda
  // ushlanmaydi, chunki `finally` allaqachon o'tgan.
  const sessiyaBor = sessiyaOqi(sessionId) !== null
  // Turn'ni YO'QOTMASLIK sharti: matn, tool yoki agent konteksti — uchtadan
  // biri bo'lsa yoziladi. Ilgari faqat birinchi ikkitasi tekshirilardi va
  // provider bo'sh javob qaytarganda (yoki xato jimgina yutilganda) butun
  // javob bazaga umuman tushmasdi: foydalanuvchi xabari tarixda yolg'iz
  // qolib, keyingi turn'da nima bo'lganini hech kim bilmasdi.
  const yozishKerak =
    saqlanadigan.length > 0 || toolCards.length > 0 || (agentXabarlari?.length ?? 0) > 0
  if (sessiyaBor && yozishKerak) {
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

  if (xato && !toxtatildi) {
    hub.broadcast({ type: 'chat.error', sessionId, messageId, error: xato })
    auditYoz('chat', 'LLM javobi xato', `${tanlov.provider}/${tanlov.model}`, "o'qish", 'rad etildi')
  } else if (toxtatildi) {
    // UI uchun bu oddiy tugash: oqim yopiladi, qizil ogohlantirish chiqmaydi.
    hub.broadcast({
      type: 'chat.done',
      sessionId,
      messageId,
      usage: { input: 0, output: 0, cost: 0 },
    })
    auditYoz('chat', "LLM javobi to'xtatildi", `${tanlov.provider}/${tanlov.model}`, "o'qish", 'OK')
  } else {
    auditYoz('chat', 'LLM javobi', `${tanlov.provider}/${tanlov.model}`, "o'qish", 'OK')
  }

  // Yakuniy holat — to'xtatish (abort) ham shu yerdan o'tadi: bekor qilingan
  // oqim ham shu nuqtaga yetib keladi, ya'ni sidebar indikatori har holatda
  // yopiladi. Bizni yangi oqim almashtirgan bo'lsa tarqatmaymiz (yuqoriga q.).
  if (ozimizniki) holatTarqat(sessionId, xato && !toxtatildi ? 'xato' : 'tugadi')

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
    ? config({ ishPapkasi: sessiyaPapkasi(sessionId) }).config
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

/**
 * Sessiyada hozir javob kutayotgan ruxsat so'rovlari.
 *
 * NEGA KERAK. `chat.permission` — bir marta yuboriladigan WS eventi. U
 * yetib bormasa (mijoz hali `sub` yubormagan, qayta ulanish oynasi, sahifa
 * oqim o'rtasida ochilgan) so'rov UI'da HECH QACHON ko'rinmaydi va agent
 * javob kutib turaveradi — foydalanuvchi uchun bu "chat qotib qoldi".
 *
 * Eventga qo'shimcha ravishda SO'RASH mumkin bo'lgan manba shu poyganing
 * butun sinfini zararsiz qiladi: UI sahifa ochilganda va har qayta
 * ulanishda holatni shu yerdan tiklaydi. `chat.status` dagi
 * `ruxsat-kutmoqda` bilan bir xil mantiq (`GET /api/chat/running`).
 */
export function kutayotganRuxsatlar(sessionId: string): RuxsatSorovi[] {
  return ruxsatBoshqaruvchisi(sessionId).kutayotganSorovlar
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

/**
 * Sessiyadagi oqimni bekor qiladi (foydalanuvchi to'xtatdi).
 *
 * Yakuniy `chat.status` bu yerda TARQATILMAYDI: `abort()` dan keyin oqim
 * o'zi tugaydi va `javobOqizi` oxiridagi umumiy tugallash yo'li 'tugadi'
 * yoki 'xato' ni yuboradi. Ikki joydan yuborilsa UI ikkita event olardi.
 */
export function oqimniToxtat(sessionId: string): boolean {
  const oqim = ishlayotgan.get(sessionId)
  if (!oqim) return false
  oqim.boshqaruv.abort()
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
