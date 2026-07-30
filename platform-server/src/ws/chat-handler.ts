// WS orqali kelgan `chat.send` eventini orchestratorga uzatadi.
//
// REST `POST /api/chat/send` bilan AYNAN bir xil mantiqdan o'tadi
// (`chat-yuborish.ts`: `xabarniQabulQil`) — farqi faqat xatoni qanday
// ifodalashda: HTTP status kodi o'rniga `chat.error` eventi.
//
// Ilgari bu fayl model qulfi tekshiruvini o'zi takrorlardi va ikki nusxa
// bir-biridan uzoqlashishi mumkin edi. Endi qoidalar bitta joyda.

import type { ClientEvent } from '@platforma/shared'
import { xabarniQabulQil } from '../chat-yuborish.ts'
import { javobOqizi, rejimOrnat, ruxsatJavobi } from '../orchestrator.ts'
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
  void chatSendniBajar(event, ws)
}

async function chatSendniBajar(
  event: Extract<ClientEvent, { type: 'chat.send' }>,
  ws: PlatformaWS,
): Promise<void> {
  const natija = xabarniQabulQil({
    sessionId: event.sessionId,
    matn: event.text ?? '',
    tanlangan: event.model,
    biriktirmalar: event.biriktirmalar,
  })

  if (!natija.ok) {
    // `messageId` shu yerda yaratiladi: rad etilgan xabarga ham id kerak,
    // aks holda mijoz xatoni qaysi yuborishga bog'lashni bilmaydi.
    const xabar = natija.tafsilot ? `${natija.xato} — ${natija.tafsilot}` : natija.xato
    hub.yubor(ws, {
      type: 'chat.error',
      sessionId: event.sessionId,
      messageId: crypto.randomUUID(),
      error: xabar,
    })
    return
  }

  // REST'dan FARQ: bu yerda kutamiz. WS ulanishi ochiq turadi va oqim
  // tugashini kutish hech kimni bloklamaydi (`javobOqizi` o'zi WS orqali
  // tarqatadi). REST esa 202 qaytarish uchun kutmaydi.
  await javobOqizi(event.sessionId, natija.messageId, natija.tanlov)
}
