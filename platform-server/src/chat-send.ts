// The SHARED logic for sending a message — both REST and WS pass through here.
//
// WHY IT IS SEPARATE. `routes/chat.ts` (`POST /chat/send`) and
// `ws/chat-handler.ts` used to do the same job INDEPENDENTLY: check the model
// lock, refuse a provider switch, see whether a stream is already running. Two
// copies are doomed to drift apart — one gets fixed and the other is
// forgotten, and then a message sent one way is rejected by the other. With
// attachments a third check appeared, and carrying on duplicating stopped
// making sense.
//
// This module knows about neither HTTP nor WS: it returns a `status` as its
// result, and the caller expresses that in its own language (REST — an HTTP
// code, WS — `chat.error`).

import { cachedResult } from '@platforma/ai'
import type { ChatAttachment, ModelChoice } from '@platforma/shared'
import { config } from '@platforma/config'
import { sessionWorkDir } from './work-dir.ts'
import { isStreaming } from './orchestrator.ts'
import {
  readAttachmentsByIds,
  linkAttachmentsToMessage,
  sessionProjectDir,
  changeSessionModel,
  lockSessionModel,
  readSession,
  writeMessage,
} from './repo.ts'

export interface SendRequest {
  sessionId: string
  text: string
  /** The chosen model — mandatory on the first message */
  model?: ModelChoice
  /** Attachment ids (not objects — the client does not supply the path) */
  attachments?: string[]
}

export type SendResult =
  | {
      ok: true
      messageId: string
      model: ModelChoice
      attachments: ChatAttachment[]
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string; detail?: string }

/**
 * Accepts the message: validates it, locks the model, writes it to the
 * database and links the attachments to the message.
 *
 * IT DOES NOT START THE STREAM ITSELF — the caller invokes `streamReply`. The
 * reason: REST starts it in the background and returns 202, while WS waits.
 * That difference must not leak into this module.
 *
 * THE ORDER MATTERS: every check comes BEFORE `writeMessage`. If the message
 * were written and then rejected, an orphaned user message with no reply
 * coming would be left in the database.
 */
export function acceptMessage(request: SendRequest): SendResult {
  const text = request.text.trim()
  const attachmentIds = request.attachments ?? []

  // A message with no text is allowed ONLY when there are attachments: it is
  // natural for a user to drop in an image and write nothing at all ("what is
  // this?" is clear enough from the image itself).
  if (!text && attachmentIds.length === 0) {
    return { ok: false, status: 400, error: 'Message text must not be empty' }
  }

  const session = readSession(request.sessionId)
  if (!session) return { ok: false, status: 404, error: 'Session not found' }

  if (isStreaming(request.sessionId)) {
    return {
      ok: false,
      status: 409,
      error: 'A response is still streaming in this session',
      detail: 'Wait for it to finish or stop it first',
    }
  }

  // --- Model choice and the provider lock ---
  if (!session.provider) {
    if (!request.model?.provider || !request.model.model) {
      return {
        ok: false,
        status: 400,
        error: 'No model selected',
        detail: 'The first message of a session must include model: { provider, model }',
      }
    }
    lockSessionModel(request.sessionId, request.model.provider, request.model.model)
  } else if (request.model?.provider && request.model.provider !== session.provider) {
    return {
      ok: false,
      status: 409,
      error: 'The session provider cannot be changed',
      detail: `This session is bound to the "${session.provider}" provider. Start a new conversation to use a different one.`,
    }
  } else if (request.model?.model && request.model.model !== session.model) {
    // Switching models within one provider is allowed
    changeSessionModel(request.sessionId, request.model.model)
  }

  const updated = readSession(request.sessionId)
  if (!updated?.provider || !updated.model) {
    return { ok: false, status: 500, error: 'Could not determine the session model' }
  }

  // --- Attachments ---
  const attachments = readAttachmentsByIds(request.sessionId, attachmentIds)
  if (attachments.length !== attachmentIds.length) {
    // A shortfall has two possible causes and both are client errors: the id
    // does not exist (removed / expired) or it belongs to another session. We
    // do not distinguish between them — answering "it exists in another
    // session" would itself be an information leak.
    return {
      ok: false,
      status: 404,
      error: 'Attachment not found',
      detail: 'The upload was removed or belongs to another conversation',
    }
  }

  const limit = attachmentLimit(request.sessionId)
  if (attachments.length > limit) {
    return {
      ok: false,
      status: 400,
      error: 'Attachment limit reached',
      detail: `At most ${limit}`,
    }
  }

  // THE VISION GUARD. This is the only correct place for it: the model is
  // locked/switched EXACTLY here, which means it is only known for certain
  // now. At upload time the user could still have changed the model.
  //
  // Why a 400 rather than passing it through silently: the agent reads the
  // image with `read`, the provider then drops the image block (or errors),
  // and the agent reaches the WRONG CONCLUSION that "there is nothing in the
  // image". The user does not notice — the worst kind of failure.
  if (attachments.some((a) => a.kind === 'image')) {
    const model = findModel(updated.provider, updated.model)
    if (model && !model.vision) {
      return {
        ok: false,
        status: 400,
        error: 'This model does not support images',
        detail: `${model.name} is text-only. Pick a vision-capable model or remove the image.`,
      }
    }
  }

  // --- Writing ---
  const message = writeMessage({ sessionId: request.sessionId, role: 'user', text })
  if (attachmentIds.length > 0) {
    linkAttachmentsToMessage(request.sessionId, message.id, attachmentIds)
  }

  return {
    ok: true,
    messageId: crypto.randomUUID(),
    model: { provider: updated.provider, model: updated.model },
    attachments,
  }
}

/**
 * Takes the `vision` flag from the model cache.
 *
 * When the cache is empty (the server has just come up and nobody has asked
 * for `/api/models`) this returns `undefined` and the guard LETS IT THROUGH.
 * Deliberately: `await detectModels()` would slow this path down (it goes out
 * to the network), and blocking on uncertainty would stop a user whose setup
 * actually works. The provider gives its own error anyway, and that surfaces
 * as `chat.error`.
 */
function findModel(provider: string, model: string) {
  return cachedResult()?.models.find((m) => m.provider === provider && m.id === model)
}

/** The attachment count limit from the session's config */
function attachmentLimit(sessionId: string): number {
  const dir = sessionWorkDir(sessionId, sessionProjectDir(sessionId))
  return config({ workDir: dir }).config.chat.attachment.maxCount
}
