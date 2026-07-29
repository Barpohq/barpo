// Serverlar — SSH orqali boshqariladigan mashinalar.
//
// Server qo'shish = parolsiz ulanishni O'RNATISH:
//   1) platforma kaliti serverning authorized_keys'iga joylanadi
//      (mavjud kalit bilan, bo'lmasa bir martalik parol bilan — ssh.ts),
//   2) yozuv bazaga tushadi,
//   3) boshqariladigan ssh config qayta yoziladi + ~/.ssh/config'ga Include —
//      shundan keyin terminalda ham `ssh <nom>` parolsiz ishlaydi.
//
// PAROL SAQLANMAYDI: u faqat shu bitta so'rov davomida sshpass'ga env orqali
// beriladi va javob qaytishi bilan yo'qoladi. Bazada faqat host/port/user.
//
// Jonli holat (metrikalar) alohida endpoint'da va har safar SSH orqali
// o'qiladi — bazaga yozilmaydi (eskirgan qiymat "ishonchli yolg'on" bo'lardi).

import { Hono } from 'hono'
import { auditYoz } from '../audit.ts'
import {
  serverIdBoyicha,
  serverNomBoyicha,
  serverOchir,
  serverYarat,
  serverlarOqi,
} from '../repo.ts'
import {
  boshqarilganConfigYoz,
  includeTaminla,
  kalitJoyla,
  metrikaOl,
  ulanishniTekshir,
} from '../ssh.ts'

export const serversRoutes = new Hono()

// Nom — ssh alias: qat'iy allowlist, aks holda config fayl va buyruq
// qatoriga nazoratsiz matn tushadi. Kichik harf majburiy emas, lekin
// boshqa belgi yo'q.
const NOM_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/
// Host — domen yoki IP (IPv6 uchun ':' ham). Bo'shliq va tirnoq kirmaydi.
const HOST_REGEX = /^[a-zA-Z0-9.:_-]{1,253}$/
// Unix username qoidasi
const USER_REGEX = /^[a-z_][a-z0-9_-]{0,31}$/

serversRoutes.get('/servers', (c) => {
  return c.json({ servers: serverlarOqi() })
})

serversRoutes.post('/servers', async (c) => {
  let tana: {
    name?: unknown
    host?: unknown
    port?: unknown
    username?: unknown
    parol?: unknown
  }
  try {
    tana = (await c.req.json()) as typeof tana
  } catch {
    return c.json({ error: "So'rov tanasi JSON bo'lishi kerak" }, 400)
  }

  const name = typeof tana.name === 'string' ? tana.name.trim() : ''
  const host = typeof tana.host === 'string' ? tana.host.trim() : ''
  const username = typeof tana.username === 'string' && tana.username.trim() !== ''
    ? tana.username.trim()
    : 'root'
  const port = tana.port === undefined || tana.port === '' ? 22 : Number(tana.port)
  const parol = typeof tana.parol === 'string' && tana.parol !== '' ? tana.parol : undefined

  if (!NOM_REGEX.test(name)) {
    return c.json(
      {
        error: "Server nomi noto'g'ri",
        detail: "Harf/raqam bilan boshlanib, faqat harf, raqam, '-' va '_' dan iborat bo'lsin (40 tagacha)",
      },
      400,
    )
  }
  if (!HOST_REGEX.test(host)) {
    return c.json({ error: "Host noto'g'ri", detail: 'Domen yoki IP manzil kiriting' }, 400)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return c.json({ error: "Port noto'g'ri", detail: '1 dan 65535 gacha butun son' }, 400)
  }
  if (!USER_REGEX.test(username)) {
    return c.json({ error: "Foydalanuvchi nomi noto'g'ri" }, 400)
  }

  if (serverNomBoyicha(name)) {
    return c.json({ error: 'Bunday nomli server allaqachon bor', detail: name }, 409)
  }

  // Avval kalit joylanadi, KEYIN baza: ulanish umuman bo'lmasa bazada
  // "ishlamaydigan server" yozuvi qolib ketmasin.
  try {
    await kalitJoyla({ host, port, username }, parol)
  } catch (xato) {
    auditYoz('foydalanuvchi', 'Server ulash muvaffaqiyatsiz', `${username}@${host}`, "o'zgartirish", 'rad etildi')
    return c.json(
      { error: "Serverga ulanib bo'lmadi", detail: xato instanceof Error ? xato.message : String(xato) },
      502,
    )
  }

  const server = serverYarat({ name, host, port, username })

  // Config bazadagi TO'LIQ ro'yxatdan qayta quriladi — bitta haqiqat manbai.
  boshqarilganConfigYoz(serverlarOqi())
  includeTaminla()

  // Yakuniy tasdiq: endi alias orqali, faqat platforma kaliti bilan.
  // Muvaffaqiyatsiz bo'lsa ham server saqlangan — foydalanuvchi kartadagi
  // holatdan ko'radi, qo'shishni qaytarish shart emas.
  let ulanishXatosi: string | undefined
  try {
    await ulanishniTekshir(name)
  } catch (xato) {
    ulanishXatosi = xato instanceof Error ? xato.message : String(xato)
  }

  auditYoz(
    'foydalanuvchi',
    'Server ulandi — SSH kalit joylandi',
    `${name} (${username}@${host})`,
    "o'zgartirish",
    ulanishXatosi ? 'kutmoqda' : 'OK',
  )

  return c.json({ server, ulanishXatosi }, 201)
})

serversRoutes.delete('/servers/:id', (c) => {
  const id = c.req.param('id')
  const server = serverIdBoyicha(id)
  if (!server) {
    return c.json({ error: 'Server topilmadi', detail: id }, 404)
  }

  serverOchir(id)
  boshqarilganConfigYoz(serverlarOqi())

  auditYoz('foydalanuvchi', "Server o'chirildi", server.name, "o'zgartirish")

  // Kalit serverning o'zida QOLADI — uni olib tashlash uchun serverga
  // ulanish kerak, o'chirilayotgan server esa aynan ulanmayotgan bo'lishi
  // mumkin. UI buni foydalanuvchiga aytadi.
  return c.json({ ok: true, eslatma: `Platforma kaliti ${server.name} dagi authorized_keys'da qoladi` })
})

serversRoutes.get('/servers/:id/metrika', async (c) => {
  const id = c.req.param('id')
  const server = serverIdBoyicha(id)
  if (!server) {
    return c.json({ error: 'Server topilmadi', detail: id }, 404)
  }

  // metrikaOl hech qachon throw qilmaydi — xato holati ham oddiy javob
  const metrika = await metrikaOl(server.name)
  return c.json({ metrika })
})
