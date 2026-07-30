// Chat sessiyalari va xabarlari.
//
// POST /api/chat/send foydalanuvchi xabarini saqlaydi, sessiya modelini
// qulflaydi va javob oqimini FONDA boshlaydi — javob WS orqali keladi
// (chat.delta → chat.done yoki chat.error). Shuning uchun 202 qaytadi:
// so'rov qabul qilindi, natija keyinroq.

import { config } from '@platforma/config'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rasmKengaytmasi, rasmTuri, SIGNATURA_BAYTLARI } from '../biriktirma.ts'
import { xabarniQabulQil } from '../chat-yuborish.ts'
import {
  bandsizNom,
  SESSIYA_PAPKASI,
  sessiyaFayllarPapkasi,
  sessiyaIshPapkasi,
  yuklamaNomi,
} from '../ish-papkasi.ts'
import {
  ishlayotganSessiyalar,
  javobOqizi,
  kutayotganRuxsatlar,
  oqimBormi,
  oqimniToxtat,
  rejimHolati,
  rejimOrnat,
  ruxsatJavobi,
} from '../orchestrator.ts'
import {
  biriktirmaBoglanganmi,
  biriktirmaOchir,
  biriktirmaOqi,
  biriktirmaYoz,
  loyihaOqi,
  sessiyaBiriktirmalari,
  sessiyaLoyihaPapkasi,
  sessiyaOchir,
  sessiyaOqi,
  sessiyaSarlavhaOzgart,
  sessiyaYarat,
  sessiyalarOqi,
  xabarlarOqi,
} from '../repo.ts'

export const chatRoutes = new Hono()

chatRoutes.get('/chat/sessions', (c) => {
  return c.json({ sessions: sessiyalarOqi() })
})

/**
 * Yangi sessiya. `projectId` ixtiyoriy — berilsa sessiya loyihaga ulanadi
 * va agent tool'lari loyiha papkasida ishlaydi.
 */
chatRoutes.post('/chat/sessions', async (c) => {
  let title: string | undefined
  let projectId: string | undefined
  try {
    const tana = (await c.req.json()) as { title?: unknown; projectId?: unknown }
    if (typeof tana?.title === 'string') title = tana.title
    if (typeof tana?.projectId === 'string' && tana.projectId.length > 0) {
      projectId = tana.projectId
    }
  } catch {
    // tana bo'sh bo'lishi mumkin — sarlavha avtomatik qo'yiladi
  }

  // Yo'q loyiha id'si bilan sessiya yaratilsa foreign key xatosi 500 bo'lib
  // chiqardi — bu yerda tushunarli 404 beramiz.
  if (projectId && !loyihaOqi(projectId)) {
    return c.json({ error: 'Project not found', detail: projectId }, 404)
  }

  return c.json({ session: sessiyaYarat(title, undefined, projectId) }, 201)
})

/**
 * Hozir agent oqimi ketayotgan sessiyalar — "fon agentlari" ko'rinishi uchun.
 *
 * UI (sidebar badge'lari va Agentlar sahifasi) sahifa ochilganda boshlang'ich
 * holatni shu yerdan oladi, keyin `chat.status` WS eventlari bilan yangilaydi.
 * Faqat WS'ga tayanib bo'lmaydi: sahifa oqim o'rtasida ochilsa, boshlanish
 * eventi allaqachon o'tib ketgan bo'ladi.
 *
 * `title` sessiya jadvalidan qo'shiladi — UI id o'rniga o'qiladigan nom
 * ko'rsatsin. Sessiya o'chirilgan bo'lsa (kutilmagan holat) `title`siz keladi.
 */
chatRoutes.get('/chat/running', (c) => {
  const running = ishlayotganSessiyalar().map((s) => ({
    ...s,
    title: sessiyaOqi(s.sessionId)?.title,
  }))
  return c.json({ running })
})

/**
 * Bitta sessiya — URL'dan tiklash uchun.
 *
 * Sahifa `#chat/<uuid>` bilan ochilganda UI shu yerdan sessiyaning modelini
 * va loyihasini oladi (xabarlar alohida so'rovda). Sessiya o'chirilgan yoki
 * URL noto'g'ri bo'lsa 404 — UI uni bo'sh chatga tushish signali deb biladi.
 */
chatRoutes.get('/chat/sessions/:id', (c) => {
  const sessiya = sessiyaOqi(c.req.param('id'))
  if (!sessiya) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session: sessiya })
})

chatRoutes.get('/chat/sessions/:id/messages', (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Session not found' }, 404)
  return c.json({ messages: xabarlarOqi(id) })
})

/** Sarlavha uzunligi chegarasi — sidebar va ro'yxatda bir qatorga sig'sin */
const SARLAVHA_MAX = 200

/**
 * Sarlavhani qayta nomlash. Hozircha faqat `title` o'zgartiriladi: model
 * va loyiha suhbat boshlangach qulflanadi (`/chat/send` ga q.), ularni bu
 * yerdan almashtirish kontekstni buzardi.
 */
chatRoutes.patch('/chat/sessions/:id', async (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Session not found' }, 404)

  let tana: { title?: unknown }
  try {
    tana = (await c.req.json()) as { title?: unknown }
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof tana.title !== 'string') {
    return c.json({ error: 'title is required' }, 400)
  }
  const title = tana.title.trim()
  if (title.length === 0) {
    return c.json({ error: 'Title must not be empty' }, 400)
  }
  if (title.length > SARLAVHA_MAX) {
    return c.json(
      { error: 'Title too long', detail: `At most ${SARLAVHA_MAX} characters` },
      400,
    )
  }

  sessiyaSarlavhaOzgart(id, title)
  return c.json({ session: sessiyaOqi(id) })
})

/**
 * Suhbatni o'chirish. Xabarlar bazada CASCADE bilan ketadi.
 *
 * Oqim ketayotgan bo'lsa avval to'xtatiladi: aks holda agent o'chirilgan
 * sessiyaga javob yozishga urinardi (`xabarYoz` foreign key xatosi berardi)
 * va WS'ga mavjud bo'lmagan suhbat eventlari kelaverardi.
 */
chatRoutes.delete('/chat/sessions/:id', (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Session not found' }, 404)

  const oqimToxtatildi = oqimBormi(id) ? oqimniToxtat(id) : false

  // Biriktirilgan fayllar diskdan ham ketadi. Yozuvlarni CASCADE oladi,
  // fayllarni esa hech kim olmaydi — ular sessiyaning O'Z papkasida
  // (`.platforma/sessiyalar/<id>/`), ya'ni loyihali suhbatda ham begona
  // narsaga tegilmaydi.
  //
  // `sessiyaOchir` dan OLDIN: keyin bo'lsa loyiha papkasini bilish uchun
  // sessiya yozuvi kerak bo'lardi, u esa allaqachon o'chirilgan bo'lardi.
  //
  // Xato yutiladi: papka tozalanmagani sessiyani o'chirmaslik uchun asos
  // emas (`xotiraniTayyorla` dagi bilan bir xil qoida).
  try {
    const papka = sessiyaIshPapkasi(id, sessiyaLoyihaPapkasi(id))
    const xavfsizId = id.replace(/[^a-zA-Z0-9_-]/g, '')
    if (xavfsizId) {
      rmSync(join(papka, SESSIYA_PAPKASI, xavfsizId), { recursive: true, force: true })
    }
  } catch {
    // jim o'tamiz — sabab yuqoridagi izohda
  }

  sessiyaOchir(id)
  return c.json({ ochirildi: true, oqimToxtatildi })
})

interface YuborishTanasi {
  sessionId?: unknown
  text?: unknown
  model?: { provider?: unknown; model?: unknown }
  biriktirmalar?: unknown
}

/**
 * Xabar yuborish. Tekshiruv va yozish mantiqi `chat-yuborish.ts` da —
 * WS yo'li ham AYNAN shu funksiyani chaqiradi, ya'ni ikki yo'l bir xil
 * qoidalar bo'yicha ishlaydi.
 *
 * 202 qaytadi: so'rov qabul qilindi, javob esa WS orqali oqadi.
 */
chatRoutes.post('/chat/send', async (c) => {
  let tana: YuborishTanasi
  try {
    tana = (await c.req.json()) as YuborishTanasi
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof tana.sessionId !== 'string' || tana.sessionId.length === 0) {
    return c.json({ error: 'sessionId is required' }, 400)
  }
  if (typeof tana.text !== 'string') {
    return c.json({ error: 'text is required' }, 400)
  }
  if (tana.biriktirmalar !== undefined && !idRoyxatimi(tana.biriktirmalar)) {
    return c.json({ error: 'biriktirmalar must be an array of id strings' }, 400)
  }

  const natija = xabarniQabulQil({
    sessionId: tana.sessionId,
    matn: tana.text,
    tanlangan:
      matnMi(tana.model?.provider) && matnMi(tana.model?.model)
        ? { provider: tana.model!.provider as string, model: tana.model!.model as string }
        : undefined,
    biriktirmalar: tana.biriktirmalar,
  })

  if (!natija.ok) {
    return c.json({ error: natija.xato, detail: natija.tafsilot }, natija.status)
  }

  // Fonda oqizamiz — javobni kutmaymiz, u WS orqali boradi
  void javobOqizi(tana.sessionId, natija.messageId, natija.tanlov)

  return c.json({ messageId: natija.messageId, model: natija.tanlov }, 202)
})

/**
 * Ruxsat so'roviga javob. WS `chat.permission.reply` bilan bir xil ish
 * qiladi — mijoz qaysi biri qulay bo'lsa shuni ishlatadi.
 */
chatRoutes.post('/chat/permission', async (c) => {
  let tana: { sessionId?: unknown; sorovId?: unknown; javob?: unknown }
  try {
    tana = (await c.req.json()) as typeof tana
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const sessionId = matnMi(tana.sessionId)
  const sorovId = matnMi(tana.sorovId)
  const javob = tana.javob
  if (!sessionId || !sorovId) {
    return c.json({ error: 'sessionId and sorovId are required' }, 400)
  }
  if (javob !== 'ruxsat' && javob !== 'rad' && javob !== 'hardoim') {
    return c.json({ error: "javob must be 'ruxsat', 'rad' or 'hardoim'" }, 400)
  }

  const berildi = ruxsatJavobi(sessionId, sorovId, javob)
  if (!berildi) {
    return c.json(
      { error: 'Request not found', detail: 'It has expired or was already answered' },
      404,
    )
  }
  return c.json({ qabulQilindi: true })
})

/**
 * Sessiyada javob kutayotgan ruxsat so'rovlari.
 *
 * UI buni sahifa ochilganda va WS qayta ulanganda so'raydi: `chat.permission`
 * bir marta yuboriladi va yetib bormasligi mumkin (`kutayotganRuxsatlar`
 * izohiga q.). Shusiz agent javob kutib turadi, foydalanuvchi esa nima
 * kutilayotganini ko'rmaydi.
 */
chatRoutes.get('/chat/sessions/:id/ruxsatlar', (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Session not found' }, 404)
  return c.json({ sorovlar: kutayotganRuxsatlar(id) })
})

/** Sessiyaning hozirgi ruxsat rejimi */
chatRoutes.get('/chat/sessions/:id/rejim', (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Session not found' }, 404)
  return c.json({ holat: rejimHolati(id) })
})

/**
 * Ruxsat rejimini o'zgartirish. Auto o'z-o'zidan o'chgan bo'lsa
 * ("Qayta yoqish") ham shu marshrut ishlatiladi.
 */
chatRoutes.post('/chat/sessions/:id/rejim', async (c) => {
  const id = c.req.param('id')
  if (!sessiyaOqi(id)) return c.json({ error: 'Session not found' }, 404)

  let rejim: unknown
  try {
    const tana = (await c.req.json()) as { rejim?: unknown }
    rejim = tana?.rejim
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (rejim !== 'tasdiq' && rejim !== 'auto') {
    return c.json({ error: "rejim must be 'tasdiq' or 'auto'" }, 400)
  }
  return c.json({ holat: await rejimOrnat(id, rejim) })
})

// ---------------------------------------------------------------------------
// Biriktirmalar — chatga yuklangan fayl va rasmlar
// ---------------------------------------------------------------------------
//
// NEGA `/chat/send` DAN AJRATILGAN. Fayl yuklash sekin (megabaytlar), xabar
// yuborish tez. Bir so'rovda bo'lsa foydalanuvchi fayl yuklanguncha matn
// yozib ham o'tira olmasdi va progress ko'rsatib bo'lmasdi. Endi: fayl
// tanlanadi → yuklanadi → chip ko'rinadi → matn yoziladi → `send` faqat
// id'larni yuboradi (kichik JSON).
//
// Yon foyda: WS `chat.send` ham id'lar bilan ishlaydi, ya'ni ikki yo'l
// (REST va WS) bir xil qoladi — binary WS'da umuman yo'q.

/**
 * Tananing qattiq yuqori shifti — DoS'ga qarshi.
 *
 * Config'dagi haqiqiy chegara (`chat.biriktirma.maksFaylMb`) handler ICHIDA
 * qo'llanadi. Nega ikki qatlam: middleware modul yuklanganda quriladi, config
 * esa sessiyaning ish papkasiga bog'liq (`config({ ishPapkasi })`) va u
 * so'rov paytida ma'lum bo'ladi. Ya'ni bu yerdagi son "hech qanday holatda
 * bundan oshmaydi", handler'dagi son esa "foydalanuvchi sozlagani".
 */
const TANA_YUQORI_SHIFT = 256 * 1024 * 1024

/** Rasm nomi bo'sh kelganda ishlatiladigan asos (Windows paste'da shunday bo'ladi) */
const RASM_ZAXIRA_NOMI = 'image'

/**
 * Fayl yoki rasm biriktirish (multipart).
 *
 * `sessionId` MAJBURIY: fayl darhol sessiyaning papkasiga tushadi. UI
 * sessiyani fayl tanlangan payt yaratadi — bo'sh sessiya qolishi platformada
 * normal holat (`ChatSession.xabarlarSoni` izohiga q.).
 *
 * TARTIB: avval diskka, keyin bazaga (`routes/projects.ts` dagi papka→yozuv
 * tartibi bilan bir xil sabab). Baza yozuvi yiqilsa fayl yetim qoladi —
 * agent uni ko'radi, zarari yo'q; teskarisi (bazada bor, diskda yo'q) esa
 * o'qishda xato berardi.
 */
chatRoutes.post(
  '/chat/biriktirma',
  bodyLimit({
    maxSize: TANA_YUQORI_SHIFT,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  async (c) => {
    let forma: FormData
    try {
      forma = await c.req.formData()
    } catch {
      return c.json({ error: 'Request must be multipart/form-data' }, 400)
    }

    const sessionId = matnMi(forma.get('sessionId'))
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400)

    const sessiya = sessiyaOqi(sessionId)
    if (!sessiya) return c.json({ error: 'Session not found' }, 404)

    // `File` dan boshqasi (matn maydoni) tashlanadi — mijoz xato yuborgan
    const fayllar = forma.getAll('fayl').filter((f): f is File => f instanceof File)
    if (fayllar.length === 0) {
      return c.json({ error: 'No file was sent', detail: '`fayl` field is empty' }, 400)
    }

    const papka = sessiyaIshPapkasi(sessionId, sessiyaLoyihaPapkasi(sessionId))
    const { config: sozlamalar } = config({ ishPapkasi: papka })
    const maksBayt = sozlamalar.chat.biriktirma.maksFaylMb * 1024 * 1024
    const maksSoni = sozlamalar.chat.biriktirma.maksSoni

    // Mavjudlar bilan birga chegaradan oshmasin. Bog'lanmaganlar ham
    // sanaladi: foydalanuvchi ularni hali yuborishi mumkin.
    const mavjudSoni = sessiyaBiriktirmalari(sessionId).length
    if (mavjudSoni + fayllar.length > maksSoni) {
      return c.json(
        {
          error: 'Attachment limit reached',
          detail: `At most ${maksSoni} (currently ${mavjudSoni})`,
        },
        400,
      )
    }

    for (const fayl of fayllar) {
      if (fayl.size === 0) {
        return c.json({ error: 'Empty files cannot be attached', detail: fayl.name }, 400)
      }
      if (fayl.size > maksBayt) {
        return c.json(
          {
            error: 'File too large',
            detail: `${fayl.name} — ${(fayl.size / 1024 / 1024).toFixed(1)} MB, limit ${sozlamalar.chat.biriktirma.maksFaylMb} MB`,
          },
          413,
        )
      }
    }

    const { toliq, nisbiy } = sessiyaFayllarPapkasi(papka, sessionId)
    const natija = []

    for (const fayl of fayllar) {
      const bayt = new Uint8Array(await fayl.arrayBuffer())

      // TUR MAZMUNDAN aniqlanadi, `fayl.type` dan emas: mijoz uni
      // soxtalashtira oladi va u `GET` javobining `content-type` iga
      // aylanardi (`biriktirma.ts` izohiga q.).
      const rasm = rasmTuri(bayt.subarray(0, SIGNATURA_BAYTLARI))

      // Nom bo'sh yoki butunlay tashlanadigan belgilardan iborat bo'lsa
      // zaxira nom. Rasm paste'ida `File.name` ko'pincha bo'sh keladi.
      const tozaNom =
        yuklamaNomi(fayl.name) ??
        (rasm ? `${RASM_ZAXIRA_NOMI}.${rasmKengaytmasi(rasm)}` : 'file')
      const nom = bandsizNom(toliq, tozaNom)

      // `wx` — fayl allaqachon bo'lsa xato beradi. `bandsizNom` va yozish
      // orasida poyga bor (ikki so'rov bir vaqtda), shu bayroq uni ushlaydi.
      try {
        writeFileSync(join(toliq, nom), bayt, { flag: 'wx' })
      } catch {
        // Poyga: nomni qayta so'rab bir marta urinamiz. Yana bo'lsa xato —
        // uchinchi urinish ehtimoli shunchalik kichik va cheksiz halqa
        // qilishdan ko'ra tushunarli xato yaxshi.
        const ikkinchi = bandsizNom(toliq, tozaNom)
        try {
          writeFileSync(join(toliq, ikkinchi), bayt, { flag: 'wx' })
          natija.push(
            biriktirmaYoz({
              sessionId,
              tur: rasm ? 'rasm' : 'fayl',
              nom: ikkinchi,
              aslNom: fayl.name || tozaNom,
              yol: join(nisbiy, ikkinchi),
              mime: rasm ?? 'application/octet-stream',
              hajm: bayt.byteLength,
            }),
          )
          continue
        } catch {
          return c.json({ error: 'Could not save the file', detail: fayl.name }, 500)
        }
      }

      // MIME faqat rasm uchun haqiqiy. Fayl uchun `application/octet-stream`
      // ATAYLAB: `fayl.type` mijozdan keladi va `text/html` deb yozilsa
      // `GET` javobida saqlangan XSS bo'lardi.
      natija.push(
        biriktirmaYoz({
          sessionId,
          tur: rasm ? 'rasm' : 'fayl',
          nom,
          aslNom: fayl.name || tozaNom,
          yol: join(nisbiy, nom),
          mime: rasm ?? 'application/octet-stream',
          hajm: bayt.byteLength,
        }),
      )
    }

    return c.json({ biriktirmalar: natija }, 201)
  },
)

/**
 * Biriktirilgan faylni berish — UI rasm ko'rsatishi va yuklab olish uchun.
 *
 * Loyihada BIRINCHI binary qaytaradigan marshrut.
 *
 * XAVFSIZLIK. Ikki qat'iy qoida:
 *   1) Yo'l SERVERDA quriladi (`sessiyaIshPapkasi` + bazadagi nisbiy yo'l).
 *      Mijoz faqat `id` beradi. Shundan keyin ham chegara QAYTA tekshiriladi
 *      — bazaga qandaydir yo'l bilan buzuq yozuv tushsa ham papkadan
 *      chiqib ketmaslik kerak.
 *   2) `content-type` FAQAT rasm uchun haqiqiy va `inline`. Qolgan hamma
 *      narsa `application/octet-stream` + `attachment`, ya'ni brauzer uni
 *      hech qachon sahifa sifatida ochmaydi (saqlangan XSS yo'li yopiladi).
 */
chatRoutes.get('/chat/biriktirma/:id', (c) => {
  const biriktirma = biriktirmaOqi(c.req.param('id'))
  if (!biriktirma) return c.json({ error: 'Attachment not found' }, 404)

  const papka = sessiyaIshPapkasi(biriktirma.sessionId, sessiyaLoyihaPapkasi(biriktirma.sessionId))
  const toliq = join(papka, biriktirma.yol)
  if (!toliq.startsWith(`${papka}/`)) {
    return c.json({ error: 'Invalid path' }, 400)
  }

  const fayl = Bun.file(toliq)
  const rasmmi = biriktirma.tur === 'rasm'
  // Nom sarlavhaga tushadi — ASCII bo'lmagan belgi va qo'shtirnoq sarlavhani
  // buzadi, shuning uchun kodlanadi
  const nom = encodeURIComponent(biriktirma.aslNom)

  return new Response(fayl, {
    headers: {
      'content-type': rasmmi ? biriktirma.mime : 'application/octet-stream',
      'content-disposition': `${rasmmi ? 'inline' : 'attachment'}; filename*=UTF-8''${nom}`,
      // Brauzer mime turini o'zi "taxmin qilib" HTML deb ochmasin
      'x-content-type-options': 'nosniff',
      // Mazmun o'zgarmaydi (id noyob), lekin `private` — javob umumiy
      // keshga tushmasligi kerak
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
})

/**
 * Biriktirmani olib tashlash — foydalanuvchi chipdagi `×` ni bosdi.
 *
 * Xabarga BOG'LANGAN biriktirma o'chirilmaydi: u allaqachon suhbat tarixining
 * bir qismi va agent uni ko'rgan. Tarixni orqaga o'zgartirish yolg'on
 * kontekst yaratardi — o'chirish faqat yuborishdan OLDIN mumkin.
 */
chatRoutes.delete('/chat/biriktirma/:id', (c) => {
  const id = c.req.param('id')
  const biriktirma = biriktirmaOqi(id)
  if (!biriktirma) return c.json({ error: 'Attachment not found' }, 404)

  if (biriktirmaBoglanganmi(id)) {
    return c.json(
      {
        error: 'A sent attachment cannot be removed',
        detail: 'It is part of the conversation history — the agent has already seen it',
      },
      409,
    )
  }

  const papka = sessiyaIshPapkasi(biriktirma.sessionId, sessiyaLoyihaPapkasi(biriktirma.sessionId))
  // Fayl AVVAL o'chiriladi, keyin yozuv: teskari tartibda fayl yetim
  // qolardi (yozuvsiz fayl uni topish yo'lini ham yo'qotadi)
  try {
    unlinkSync(join(papka, biriktirma.yol))
  } catch {
    // Fayl allaqachon yo'q bo'lishi mumkin — yozuvni baribir tozalaymiz
  }
  biriktirmaOchir(id)

  return c.json({ ochirildi: true })
})

/** Javob oqimini to'xtatish */
chatRoutes.post('/chat/stop', async (c) => {
  let sessionId: string | undefined
  try {
    const tana = (await c.req.json()) as { sessionId?: unknown }
    sessionId = matnMi(tana?.sessionId)
  } catch {
    // pastda tekshiriladi
  }
  if (!sessionId) return c.json({ error: 'sessionId is required' }, 400)
  return c.json({ toxtatildi: oqimniToxtat(sessionId) })
})

function matnMi(qiymat: unknown): string | undefined {
  return typeof qiymat === 'string' && qiymat.length > 0 ? qiymat : undefined
}

/** Biriktirma id'lari massivimi — bo'sh massiv ham to'g'ri */
function idRoyxatimi(qiymat: unknown): qiymat is string[] {
  return Array.isArray(qiymat) && qiymat.every((q) => typeof q === 'string' && q.length > 0)
}
