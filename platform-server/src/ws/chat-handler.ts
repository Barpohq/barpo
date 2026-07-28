// WS orqali kelgan `chat.send` eventini orchestratorga uzatadi.
//
// REST `POST /api/chat/send` bilan bir xil ish qiladi, farqi — javob HTTP
// status emas, `chat.error` eventi bo'lib qaytadi (WS'da status kodi yo'q).
// Validatsiya mantig'i takrorlanmasin uchun ikkalasi ham repo va orchestrator
// funksiyalarini chaqiradi.

import type { ClientEvent } from '@platforma/shared'
import { javobOqizi, oqimBormi, rejimOrnat, ruxsatJavobi } from '../orchestrator.ts'
import { sessiyaModelniOzgart, sessiyaModelQulfla, sessiyaOqi, xabarYoz } from '../repo.ts'
import { hub, type PlatformaWS } from './hub.ts'

export function chatSendHandleri(event: ClientEvent, ws: PlatformaWS): void {
  if (event.type === 'chat.permission.reply') {
    ruxsatJavobi(event.sessionId, event.sorovId, event.javob)
    return
  }
  if (event.type === 'chat.rejim.set') {
    void rejimOrnat(event.sessionId, event.rejim)
    return
  }
  if (event.type !== 'chat.send') return
  void chatSendniBajar(event.sessionId, event.text, event.model, ws)
}

async function chatSendniBajar(
  sessionId: string,
  xomMatn: string,
  tanlangan: { provider: string; model: string } | undefined,
  ws: PlatformaWS,
): Promise<void> {
  const messageId = crypto.randomUUID()
  const xato = (xabar: string) =>
    hub.yubor(ws, { type: 'chat.error', sessionId, messageId, error: xabar })

  const matn = xomMatn?.trim()
  if (!matn) return xato("Xabar matni bo'sh")

  const sessiya = sessiyaOqi(sessionId)
  if (!sessiya) return xato('Sessiya topilmadi')

  if (oqimBormi(sessionId)) return xato('Bu sessiyada javob hali oqmoqda')

  if (!sessiya.provider) {
    if (!tanlangan?.provider || !tanlangan.model) {
      return xato("Sessiyaning birinchi xabarida model tanlanishi kerak")
    }
    sessiyaModelQulfla(sessionId, tanlangan.provider, tanlangan.model)
  } else if (tanlangan?.provider && tanlangan.provider !== sessiya.provider) {
    return xato(
      `Sessiya provideri o'zgartirib bo'lmaydi (hozirgi: ${sessiya.provider}). Yangi suhbat boshlang.`,
    )
  } else if (tanlangan?.model && tanlangan.model !== sessiya.model) {
    sessiyaModelniOzgart(sessionId, tanlangan.model)
  }

  const yangilangan = sessiyaOqi(sessionId)
  if (!yangilangan?.provider || !yangilangan.model) return xato('Sessiya modeli aniqlanmadi')

  xabarYoz({ sessionId, role: 'user', text: matn })
  await javobOqizi(sessionId, messageId, {
    provider: yangilangan.provider,
    model: yangilangan.model,
  })
}
