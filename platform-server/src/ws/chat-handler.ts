// Passes a `chat.send` event arriving over WS on to the orchestrator.
//
// It goes through EXACTLY the same logic as REST `POST /api/chat/send`
// (`chat-send.ts`: `acceptMessage`) — the only difference is how an error is
// expressed: a `chat.error` event instead of an HTTP status code.
//
// This file used to repeat the model-lock check itself and the two copies were
// free to drift apart. The rules now live in one place.

import type { ClientEvent } from '@platforma/shared'
import { acceptMessage } from '../chat-send.ts'
import { streamReply, setMode, answerPermission } from '../orchestrator.ts'
import { hub, type PlatformWS } from './hub.ts'

export function chatSendHandler(event: ClientEvent, ws: PlatformWS): void {
  if (event.type === 'chat.permission.reply') {
    answerPermission(event.sessionId, event.requestId, event.answer)
    return
  }
  if (event.type === 'chat.mode.set') {
    void setMode(event.sessionId, event.mode)
    return
  }
  if (event.type !== 'chat.send') return
  void runChatSend(event, ws)
}

async function runChatSend(
  event: Extract<ClientEvent, { type: 'chat.send' }>,
  ws: PlatformWS,
): Promise<void> {
  const result = acceptMessage({
    sessionId: event.sessionId,
    text: event.text ?? '',
    model: event.model,
    attachments: event.attachments,
  })

  if (!result.ok) {
    // `messageId` is generated here: a rejected message needs an id too,
    // otherwise the client cannot tell which send the error belongs to.
    const message = result.detail ? `${result.error} — ${result.detail}` : result.error
    hub.send(ws, {
      type: 'chat.error',
      sessionId: event.sessionId,
      messageId: crypto.randomUUID(),
      error: message,
    })
    return
  }

  // DIFFERENT FROM REST: here we wait. The WS connection stays open and
  // waiting for the stream to finish blocks nobody (`streamReply` fans the
  // events out over WS itself). REST does not wait, because it returns 202.
  await streamReply(event.sessionId, result.messageId, result.model)
}
