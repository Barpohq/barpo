// Kirish nuqtasi: bitta Bun.serve ichida Hono REST + WebSocket hub.
//
// Nega bitta port? UI dev serveri (vite) `/api` va `/ws` ni bitta manzilga
// proxy qiladi, prodda ham bitta jarayon — CORS va ikkita port muammosi yo'q.

import { app } from './app.ts'
import { auditYoz } from './audit.ts'
import { db } from './db.ts'
import { manbaYarat, skilllarniSinxronla } from './repo.ts'
import { standartManbaniTaminla } from './standart-skilllar.ts'
import { chatSendHandleri } from './ws/chat-handler.ts'
import { seedQol } from './seed.ts'
import { hub, yangiUlanishHolati, type UlanishHolati } from './ws/hub.ts'

const PORT = Number(process.env.PORT ?? 8787)

// 1) Baza: ochish + migratsiyalar (db() ichida avtomatik) + seed
const baza = db()
const seed = seedQol(baza)
if (seed.audit || seed.apps) {
  console.log(
    `[seed] boshlang'ich ma'lumot yozildi: ${seed.audit} audit · ${seed.apps} ilova`,
  )
}

// 1b) Platforma bilan birga kelgan standart skilllar — katalogga.
//
// Seed'dan FARQLI o'laroq har ishga tushishda bajariladi: platforma
// yangilanganda skilllar ham yangilanishi kerak (yangisi qo'shilishi,
// tavsifi o'zgarishi). Amal idempotent — mavjud o'rnatishlar saqlanadi.
const standart = standartManbaniTaminla(
  (m) => manbaYarat(m, baza),
  (manbaId, topilgan, sha) => skilllarniSinxronla(manbaId, topilgan, sha, baza),
)
if (standart) {
  console.log(`[skill] standart skilllar katalogda: ${standart.soni} ta`)
}

// 2) WS orqali kelgan chat.send eventlarini orchestratorga ulaymiz.
//    (REST /api/chat/send ham xuddi shu yo'lni ishlatadi — ikkalasi bir xil
//    natija beradi, mijoz qaysi biri qulay bo'lsa shuni tanlaydi.)
hub.handlerQosh(chatSendHandleri)

// 3) Server: HTTP so'rovlari Hono'ga, /ws upgrade qilinadi
//
// Ikkinchi generik parametr — `routes` yo'llari (satr literal birlashmasi).
// Biz `routes` ishlatmaymiz: barcha yo'llar `fetch` orqali Hono'ga boradi.
// Shuning uchun `never` beriladi — "hech qanday route yo'q" degani.
const server = Bun.serve<UlanishHolati, never>({
  port: PORT,

  fetch(req, srv) {
    const url = new URL(req.url)

    if (url.pathname === '/ws') {
      const ok = srv.upgrade(req, { data: yangiUlanishHolati() })
      if (ok) return undefined // upgrade muvaffaqiyatli — javob WS qatlamida
      return new Response('WebSocket upgrade kerak', { status: 426 })
    }

    return app.fetch(req)
  },

  websocket: {
    open(ws) {
      hub.ulandi(ws)
    },
    message(ws, xabar) {
      hub.xabarKeldi(ws, typeof xabar === 'string' ? xabar : xabar.toString())
    },
    close(ws) {
      hub.uzildi(ws)
    },
  },
})

console.log(`[platforma] http://localhost:${server.port}  ·  ws://localhost:${server.port}/ws`)

auditYoz('platforma', 'Server ishga tushdi', `port ${server.port}`, "o'qish", 'OK')

// Toza to'xtash: WAL checkpoint qilinishi uchun bazani yopamiz
function toxtat(signal: string) {
  console.log(`\n[platforma] ${signal} — to'xtatilmoqda...`)
  server.stop()
  baza.close()
  process.exit(0)
}

process.on('SIGINT', () => toxtat('SIGINT'))
process.on('SIGTERM', () => toxtat('SIGTERM'))
