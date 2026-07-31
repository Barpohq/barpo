// Chat sessions and messages.
//
// POST /api/chat/send stores the user's message, locks the session model and
// starts the response stream IN THE BACKGROUND — the response arrives over WS
// (chat.delta → chat.done or chat.error). That is why it returns 202: the
// request was accepted, the result comes later.

import { config } from '@platforma/config'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { imageExtension, imageKind, SIGNATURE_BYTES } from '../attachment.ts'
import { acceptMessage } from '../chat-send.ts'
import {
  freeName,
  SESSION_DIR,
  sessionFilesDir,
  sessionWorkDir,
  uploadName,
} from '../work-dir.ts'
import {
  runningSessions,
  streamReply,
  pendingPermissions,
  isStreaming,
  stopStream,
  modeState,
  setMode,
  answerPermission,
} from '../orchestrator.ts'
import {
  isAttachmentLinked,
  deleteAttachment,
  readAttachment,
  writeAttachment,
  readProject,
  sessionAttachments,
  sessionProjectDir,
  deleteSession,
  readSession,
  renameSession,
  createSession,
  readSessions,
  readMessages,
} from '../repo.ts'

export const chatRoutes = new Hono()

chatRoutes.get('/chat/sessions', (c) => {
  return c.json({ sessions: readSessions() })
})

/**
 * A new session. `projectId` is optional — when given, the session is bound to
 * the project and the agent's tools run in the project folder.
 */
chatRoutes.post('/chat/sessions', async (c) => {
  let title: string | undefined
  let projectId: string | undefined
  try {
    const body = (await c.req.json()) as { title?: unknown; projectId?: unknown }
    if (typeof body?.title === 'string') title = body.title
    if (typeof body?.projectId === 'string' && body.projectId.length > 0) {
      projectId = body.projectId
    }
  } catch {
    // the body may be empty — the title is then set automatically
  }

  // Creating a session with a project id that does not exist used to surface as
  // a foreign key error turned into a 500 — here we give a comprehensible 404.
  if (projectId && !readProject(projectId)) {
    return c.json({ error: 'Project not found', detail: projectId }, 404)
  }

  return c.json({ session: createSession(title, undefined, projectId) }, 201)
})

/**
 * The sessions whose agent stream is running right now — for the "background
 * agents" view.
 *
 * The UI (the sidebar badges and the Agents page) takes its initial state from
 * here when the page opens and then keeps it up to date with `chat.status` WS
 * events. Relying on WS alone is not enough: if the page opens mid-stream, the
 * event that announced the start has long since gone by.
 *
 * `title` is joined in from the session table so the UI can show a readable
 * name instead of an id. If the session has been deleted (an unexpected state)
 * it arrives without a `title`.
 */
chatRoutes.get('/chat/running', (c) => {
  const running = runningSessions().map((s) => ({
    ...s,
    title: readSession(s.sessionId)?.title,
  }))
  return c.json({ running })
})

/**
 * A single session — for restoring from the URL.
 *
 * When the page is opened with `#chat/<uuid>` the UI takes the session's model
 * and project from here (the messages come in a separate request). If the
 * session has been deleted or the URL is wrong the answer is a 404 — the UI
 * reads that as the signal to fall back to an empty chat.
 */
chatRoutes.get('/chat/sessions/:id', (c) => {
  const session = readSession(c.req.param('id'))
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session })
})

chatRoutes.get('/chat/sessions/:id/messages', (c) => {
  const id = c.req.param('id')
  if (!readSession(id)) return c.json({ error: 'Session not found' }, 404)
  return c.json({ messages: readMessages(id) })
})

/** Title length limit — it has to fit on one line in the sidebar and the list */
const TITLE_MAX = 200

/**
 * Renaming. Only `title` can be changed for now: the model and the project are
 * locked once the conversation has started (see `/chat/send`), and swapping
 * them from here would corrupt the context.
 */
chatRoutes.patch('/chat/sessions/:id', async (c) => {
  const id = c.req.param('id')
  if (!readSession(id)) return c.json({ error: 'Session not found' }, 404)

  let body: { title?: unknown }
  try {
    body = (await c.req.json()) as { title?: unknown }
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof body.title !== 'string') {
    return c.json({ error: 'title is required' }, 400)
  }
  const title = body.title.trim()
  if (title.length === 0) {
    return c.json({ error: 'Title must not be empty' }, 400)
  }
  if (title.length > TITLE_MAX) {
    return c.json(
      { error: 'Title too long', detail: `At most ${TITLE_MAX} characters` },
      400,
    )
  }

  renameSession(id, title)
  return c.json({ session: readSession(id) })
})

/**
 * Deleting a conversation. The messages go with it via CASCADE in the database.
 *
 * If a stream is running it is stopped first: otherwise the agent would try to
 * write a response into a deleted session (`writeMessage` would raise a
 * foreign key error) and events for a conversation that no longer exists would
 * keep arriving over WS.
 */
chatRoutes.delete('/chat/sessions/:id', (c) => {
  const id = c.req.param('id')
  if (!readSession(id)) return c.json({ error: 'Session not found' }, 404)

  const streamStopped = isStreaming(id) ? stopStream(id) : false

  // The attached files leave the disk as well. The records are taken by
  // CASCADE, but nothing takes the files — and they sit in the session's OWN
  // folder (`.platforma/sessiyalar/<id>/`), so even in a project-bound
  // conversation nothing belonging to anyone else is touched.
  //
  // BEFORE `deleteSession`: afterwards the session row would be needed to work
  // out the project folder, and it would already be gone.
  //
  // The error is swallowed: a folder that was not cleaned up is not a reason to
  // refuse to delete the session (the same rule as in `prepareMemory`).
  try {
    const dir = sessionWorkDir(id, sessionProjectDir(id))
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '')
    if (safeId) {
      rmSync(join(dir, SESSION_DIR, safeId), { recursive: true, force: true })
    }
  } catch {
    // passed over silently — the reason is in the note above
  }

  deleteSession(id)
  return c.json({ deleted: true, streamStopped })
})

interface SendBody {
  sessionId?: unknown
  text?: unknown
  model?: { provider?: unknown; model?: unknown }
  attachments?: unknown
}

/**
 * Sending a message. The validation and write logic live in `chat-send.ts` —
 * the WS path calls EXACTLY the same function, so both paths work by the same
 * rules.
 *
 * It returns 202: the request has been accepted, the response streams over WS.
 */
chatRoutes.post('/chat/send', async (c) => {
  let body: SendBody
  try {
    body = (await c.req.json()) as SendBody
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
    return c.json({ error: 'sessionId is required' }, 400)
  }
  if (typeof body.text !== 'string') {
    return c.json({ error: 'text is required' }, 400)
  }
  if (body.attachments !== undefined && !isIdList(body.attachments)) {
    return c.json({ error: 'attachments must be an array of id strings' }, 400)
  }

  const result = acceptMessage({
    sessionId: body.sessionId,
    text: body.text,
    model:
      isText(body.model?.provider) && isText(body.model?.model)
        ? { provider: body.model!.provider as string, model: body.model!.model as string }
        : undefined,
    attachments: body.attachments,
  })

  if (!result.ok) {
    return c.json({ error: result.error, detail: result.detail }, result.status)
  }

  // Streamed in the background — we do not wait for the response, it goes over WS
  void streamReply(body.sessionId, result.messageId, result.model)

  return c.json({ messageId: result.messageId, model: result.model }, 202)
})

/**
 * Answering a permission request. Does exactly the same as the WS
 * `chat.permission.reply` — the client uses whichever is more convenient.
 */
chatRoutes.post('/chat/permission', async (c) => {
  let body: { sessionId?: unknown; requestId?: unknown; answer?: unknown }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  const sessionId = isText(body.sessionId)
  const requestId = isText(body.requestId)
  const answer = body.answer
  if (!sessionId || !requestId) {
    return c.json({ error: 'sessionId and requestId are required' }, 400)
  }
  if (answer !== 'allow' && answer !== 'deny' && answer !== 'always') {
    return c.json({ error: "answer must be 'allow', 'deny' or 'always'" }, 400)
  }

  const accepted = answerPermission(sessionId, requestId, answer)
  if (!accepted) {
    return c.json(
      { error: 'Request not found', detail: 'It has expired or was already answered' },
      404,
    )
  }
  return c.json({ accepted: true })
})

/**
 * The permission requests in the session that are waiting for an answer.
 *
 * The UI asks for these when the page opens and when the WS reconnects:
 * `chat.permission` is sent once and may not arrive (see the note on
 * `pendingPermissions`). Without this the agent waits for an answer while the
 * user cannot see what is being asked.
 */
chatRoutes.get('/chat/sessions/:id/permissions', (c) => {
  const id = c.req.param('id')
  if (!readSession(id)) return c.json({ error: 'Session not found' }, 404)
  return c.json({ requests: pendingPermissions(id) })
})

/** The session's current permission mode */
chatRoutes.get('/chat/sessions/:id/mode', (c) => {
  const id = c.req.param('id')
  if (!readSession(id)) return c.json({ error: 'Session not found' }, 404)
  return c.json({ state: modeState(id) })
})

/**
 * Changing the permission mode. The same route is used when auto has switched
 * itself off and the user presses "Re-enable".
 */
chatRoutes.post('/chat/sessions/:id/mode', async (c) => {
  const id = c.req.param('id')
  if (!readSession(id)) return c.json({ error: 'Session not found' }, 404)

  let mode: unknown
  try {
    const body = (await c.req.json()) as { mode?: unknown }
    mode = body?.mode
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (mode !== 'confirm' && mode !== 'auto') {
    return c.json({ error: "mode must be 'confirm' or 'auto'" }, 400)
  }
  return c.json({ state: await setMode(id, mode) })
})

// ---------------------------------------------------------------------------
// Attachments — files and images uploaded to the chat
// ---------------------------------------------------------------------------
//
// WHY THIS IS SEPARATE FROM `/chat/send`. Uploading a file is slow
// (megabytes), sending a message is fast. In one request the user could not
// type while the file uploaded, and no progress could be shown. Now: the file
// is picked → uploaded → the chip appears → the text is written → `send` only
// carries the ids (a small JSON body).
//
// A side benefit: the WS `chat.send` works with ids too, so the two paths
// (REST and WS) stay identical — there is no binary over WS at all.

/**
 * The hard upper ceiling on the body — against DoS.
 *
 * The real limit from the config (`chat.attachment.maxFileMb`) is applied
 * INSIDE the handler. Why two layers: the middleware is built when the module
 * loads, whereas the config depends on the session's work directory
 * (`config({ workDir })`), which is only known at request time. So the number
 * here means "under no circumstances more than this", and the one in the
 * handler means "what the user configured".
 */
const BODY_CEILING = 256 * 1024 * 1024

/** The base used when an image arrives without a name (that is what a Windows paste does) */
const IMAGE_FALLBACK_NAME = 'image'

/**
 * Attaching a file or an image (multipart).
 *
 * `sessionId` is REQUIRED: the file goes straight into the session's folder.
 * The UI creates the session the moment a file is picked — an empty session is
 * a normal state on this platform (see the note on `ChatSession.messageCount`).
 *
 * ORDER: disk first, database second (the same reason as the folder→row order
 * in `routes/projects.ts`). If the database write fails the file is orphaned —
 * the agent sees it and no harm is done; the other way round (in the database
 * but not on disk) would raise an error on read.
 */
chatRoutes.post(
  '/chat/attachment',
  bodyLimit({
    maxSize: BODY_CEILING,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  async (c) => {
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return c.json({ error: 'Request must be multipart/form-data' }, 400)
    }

    const sessionId = isText(form.get('sessionId'))
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400)

    const session = readSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)

    // Anything that is not a `File` (a text field) is dropped — the client sent
    // it wrongly
    const files = form.getAll('file').filter((f): f is File => f instanceof File)
    if (files.length === 0) {
      return c.json({ error: 'No file was sent', detail: '`file` field is empty' }, 400)
    }

    const dir = sessionWorkDir(sessionId, sessionProjectDir(sessionId))
    const { config: settings } = config({ workDir: dir })
    const maxBytes = settings.chat.attachment.maxFileMb * 1024 * 1024
    const maxCount = settings.chat.attachment.maxCount

    // Together with the existing ones this must not exceed the limit. The
    // unlinked ones count too: the user may still send them.
    const existingCount = sessionAttachments(sessionId).length
    if (existingCount + files.length > maxCount) {
      return c.json(
        {
          error: 'Attachment limit reached',
          detail: `At most ${maxCount} (currently ${existingCount})`,
        },
        400,
      )
    }

    for (const file of files) {
      if (file.size === 0) {
        return c.json({ error: 'Empty files cannot be attached', detail: file.name }, 400)
      }
      if (file.size > maxBytes) {
        return c.json(
          {
            error: 'File too large',
            detail: `${file.name} — ${(file.size / 1024 / 1024).toFixed(1)} MB, limit ${settings.chat.attachment.maxFileMb} MB`,
          },
          413,
        )
      }
    }

    const { full, relative } = sessionFilesDir(dir, sessionId)
    const saved = []

    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())

      // THE KIND COMES FROM THE CONTENT, not from `file.type`: the client can
      // forge that, and it would become the `content-type` of the `GET`
      // response (see the note in `attachment.ts`).
      const image = imageKind(bytes.subarray(0, SIGNATURE_BYTES))

      // If the name is empty or consists entirely of characters that get
      // stripped, a fallback name is used. On an image paste `File.name` is
      // often empty.
      const cleanName =
        uploadName(file.name) ??
        (image ? `${IMAGE_FALLBACK_NAME}.${imageExtension(image)}` : 'file')
      const name = freeName(full, cleanName)

      // `wx` — fails if the file already exists. There is a race between
      // `freeName` and the write (two requests at once); this flag catches it.
      try {
        writeFileSync(join(full, name), bytes, { flag: 'wx' })
      } catch {
        // A race: we ask for a name again and try once more. If it happens
        // again we return an error — the chance of a third collision is so
        // small that a comprehensible error beats an endless loop.
        const second = freeName(full, cleanName)
        try {
          writeFileSync(join(full, second), bytes, { flag: 'wx' })
          saved.push(
            writeAttachment({
              sessionId,
              kind: image ? 'image' : 'file',
              name: second,
              originalName: file.name || cleanName,
              path: join(relative, second),
              mime: image ?? 'application/octet-stream',
              size: bytes.byteLength,
            }),
          )
          continue
        } catch {
          return c.json({ error: 'Could not save the file', detail: file.name }, 500)
        }
      }

      // The MIME type is only trustworthy for an image. For a file
      // `application/octet-stream` is DELIBERATE: `file.type` comes from the
      // client, and if `text/html` were written there the `GET` response would
      // be stored XSS.
      saved.push(
        writeAttachment({
          sessionId,
          kind: image ? 'image' : 'file',
          name,
          originalName: file.name || cleanName,
          path: join(relative, name),
          mime: image ?? 'application/octet-stream',
          size: bytes.byteLength,
        }),
      )
    }

    return c.json({ attachments: saved }, 201)
  },
)

/**
 * Serving an attached file — so the UI can show an image and offer a download.
 *
 * The FIRST route in the project that returns binary.
 *
 * SECURITY. Two firm rules:
 *   1) The path is built ON THE SERVER (`sessionWorkDir` + the relative path
 *      from the database). The client only supplies an `id`. Even then the
 *      boundary is checked AGAIN — if a corrupt row somehow made it into the
 *      database, we still must not escape the folder.
 *   2) The `content-type` is only trustworthy for an image, and only then is
 *      it `inline`. Everything else is `application/octet-stream` +
 *      `attachment`, i.e. the browser never opens it as a page (which closes
 *      the stored-XSS route).
 */
chatRoutes.get('/chat/attachment/:id', (c) => {
  const attachment = readAttachment(c.req.param('id'))
  if (!attachment) return c.json({ error: 'Attachment not found' }, 404)

  const dir = sessionWorkDir(attachment.sessionId, sessionProjectDir(attachment.sessionId))
  const full = join(dir, attachment.path)
  if (!full.startsWith(`${dir}/`)) {
    return c.json({ error: 'Invalid path' }, 400)
  }

  const file = Bun.file(full)
  const isImage = attachment.kind === 'image'
  // The name goes into a header — non-ASCII characters and quotes would break
  // it, so it is encoded
  const name = encodeURIComponent(attachment.originalName)

  return new Response(file, {
    headers: {
      'content-type': isImage ? attachment.mime : 'application/octet-stream',
      'content-disposition': `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
      // Stop the browser "guessing" the mime type and opening it as HTML
      'x-content-type-options': 'nosniff',
      // The content never changes (the id is unique), but `private` — the
      // response must not land in a shared cache
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
})

/**
 * Removing an attachment — the user pressed the `×` on the chip.
 *
 * An attachment already LINKED to a message is not removed: it is part of the
 * conversation history and the agent has seen it. Rewriting history backwards
 * would create a false context — removal is only possible BEFORE sending.
 */
chatRoutes.delete('/chat/attachment/:id', (c) => {
  const id = c.req.param('id')
  const attachment = readAttachment(id)
  if (!attachment) return c.json({ error: 'Attachment not found' }, 404)

  if (isAttachmentLinked(id)) {
    return c.json(
      {
        error: 'A sent attachment cannot be removed',
        detail: 'It is part of the conversation history — the agent has already seen it',
      },
      409,
    )
  }

  const dir = sessionWorkDir(attachment.sessionId, sessionProjectDir(attachment.sessionId))
  // The file goes FIRST, the record second: the other way round would leave an
  // orphaned file (and without the record there is no way left to find it)
  try {
    unlinkSync(join(dir, attachment.path))
  } catch {
    // The file may already be gone — we clean up the record regardless
  }
  deleteAttachment(id)

  return c.json({ deleted: true })
})

/** Stopping the response stream */
chatRoutes.post('/chat/stop', async (c) => {
  let sessionId: string | undefined
  try {
    const body = (await c.req.json()) as { sessionId?: unknown }
    sessionId = isText(body?.sessionId)
  } catch {
    // checked below
  }
  if (!sessionId) return c.json({ error: 'sessionId is required' }, 400)
  return c.json({ stopped: stopStream(sessionId) })
})

function isText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Is it an array of attachment ids — an empty array is valid too */
function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
}
