// The Chat page — a conversation with a real LLM.
//
// The flow: the message is sent over REST (POST /api/chat/send → 202) and the
// reply streams back in chunks over the WebSocket (chat.delta → chat.done |
// chat.error). Why the split? Whether the request was accepted (or rejected —
// a 409 provider lock, say) has to be known immediately, while the reply takes
// a long time and there is no reason to hold an HTTP response open for it.
//
// The session is created automatically on the first message and the provider
// is locked at that moment. The session history UI (the list of past
// conversations) is added in a later step.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatAttachment,
  ChatMessage,
  ModelInfo,
  ModeState,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  Project,
  ToolCall,
} from '@platforma/shared'
import AttachmentChip from '../components/AttachmentChip'
import ProjectPicker from '../components/ProjectPicker'
import Markdown from '../components/Markdown'
import ModelPicker from '../components/ModelPicker'
import ModeToggle from '../components/ModeToggle'
import ModeCard from '../components/ModeCard'
import PermissionCard from '../components/PermissionCard'
import ToolCardView from '../components/ToolCard'
import {
  ApiError,
  removeAttachment as removeAttachmentRequest,
  uploadAttachment,
  fetchProjects,
  createProject as createProjectRequest,
  fetchModels,
  stopStream,
  fetchPendingPermissions,
  fetchMode,
  setMode as setModeRequest,
  sendPermissionAnswer,
  fetchSession,
  createSession,
  fetchMessages,
  sendMessage,
} from '../lib/api'
import type { RunningMap } from '../lib/running'
import { readStoredModel } from '../lib/model-storage'
import { useToast } from '../lib/toast'
import { ws } from '../lib/ws'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** The tool calls the agent made during this reply, in order */
  toolCards?: ToolCall[]
  /** The files attached to this message (only present on `user`) */
  attachments?: ChatAttachment[]
  /** Has the reply stream finished — while false the cursor blinks */
  streaming?: boolean
  error?: string
  /**
   * The provider's quota ran out and the platform booked a continuation.
   *
   * KEPT SEPARATE FROM `error` on purpose. It is not a failure: nothing is
   * asked of the user, and rendering it in the red error box would say
   * otherwise. The text names the time the conversation picks back up.
   */
  scheduled?: string
}

/**
 * An attachment in the input field — together with its upload state.
 *
 * The server record (`record`) only appears once the upload finishes, while
 * the chip has to show up immediately — hence the local id.
 */
interface InputAttachment {
  localId: string
  name: string
  /** Uploaded — the server record. `undefined` with no `error`: still uploading. */
  record?: ChatAttachment
  error?: string
}

/**
 * Converts a stored message into its UI shape (when restoring from the URL).
 *
 * `streaming` is not set: a message coming from history has already finished.
 * Even if a stream was still running when the page was closed, it cannot be
 * followed after reopening — but the text is saved in the database.
 */
function toMessage(m: ChatMessage): Msg {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    toolCards: m.toolCards,
    attachments: m.attachments,
  }
}

/** Wraps files coming from the clipboard or an `input` into an upload state */
function toInputAttachments(files: File[]): InputAttachment[] {
  return files.map((f) => ({
    localId: crypto.randomUUID(),
    // An image from the clipboard may have no name (usual on Windows)
    name: f.name || 'image',
  }))
}

/** The input field grows no further than this — ~8 lines, then it scrolls inside */
const INPUT_MAX_HEIGHT = 200

const suggestions = [
  'Hi! Introduce yourself',
  "What's the difference between TypeScript and JavaScript?",
  'Write me a short poem',
  'Help me plan my day',
]

interface ChatProps {
  pro: boolean
  /**
   * The "new conversation" signal from outside (the sidebar). The window is
   * cleared every time it increases. A counter, because re-sending the same
   * value would not trigger the effect.
   */
  newConversationSignal?: number
  /**
   * The conversation that should be open — App owns it (the URL or a sidebar
   * choice). When it changes, that conversation is restored from the database.
   *
   * `null` — a new conversation that has not been saved yet.
   */
  openSession?: string | null
  /** When a session is created or cleared — App updates the hash */
  onSessionChanged?: (sessionId: string | null) => void
  /**
   * The sessions streaming on the server right now (App's `useRunning`).
   *
   * Why Chat needs it too: the local `busy` is only switched on when THIS
   * window sends a message, and it is lost on a page refresh. After that the
   * agent kept working in the background but the "Stop" button was gone — the
   * user could never stop it again. The server state closes that gap.
   */
  running?: RunningMap
}

export default function Chat({
  pro,
  newConversationSignal,
  openSession,
  onSessionChanged,
  running,
}: ChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * "Stop" was pressed, but the server has not confirmed the stream ended yet.
   *
   * Presentation only: the button goes away for that moment. Once the server
   * broadcasts `chat.status`, `runningOnServer` turns `false` by itself and
   * this flag is cleared in the effect below.
   */
  const [stopping, setStopping] = useState(false)
  const toast = useToast()

  const [models, setModels] = useState<ModelInfo[]>([])
  /**
   * A ref copy of `models` — for the conversation restore effect.
   *
   * The effect depends on `openSession`, i.e. it does not re-run when the
   * model list changes and closes over the list as it was when the effect was
   * created. A ref solves that without adding a dependency.
   */
  const modelsRef = useRef<ModelInfo[]>([])
  modelsRef.current = models
  const [selected, setSelected] = useState<ModelInfo | null>(null)
  const [modelLoading, setModelLoading] = useState(true)
  const [modelError, setModelError] = useState<string | null>(null)

  // Projects: the list plus the one selected for this conversation. The choice
  // can be changed until the session is created, after which it locks.
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  /**
   * A ref copy of `projects` — for the conversation restore effect.
   *
   * Same reason as `modelsRef`: the restore effect depends on `openSession`
   * and does not re-run when the project list arrives. The two load in
   * parallel and which finishes first is unknown.
   */
  const projectsRef = useRef<Project[]>([])
  projectsRef.current = projects
  /**
   * A ref copy of the selected project — for `ensureSession`.
   *
   * Same reason as `modeRef`: the helper has to stay dependency-free.
   */
  const projectRef = useRef<Project | null>(null)
  projectRef.current = project
  /**
   * The project id of the session being restored.
   *
   * A ref, because the project list may arrive AFTER the effect — the list
   * loading effect then looks the project up by this id.
   */
  const restoredProject = useRef<string | null>(null)

  const [sessionId, setSessionId] = useState<string | null>(null)
  /**
   * A ref copy of `sessionId` — for the WS listener.
   *
   * The listener registers ONCE inside `useEffect`, so it closes over the
   * state as it was when it was created (a "stale closure"). The ref always
   * gives the current value without re-registering the listener.
   */
  const sessionIdRef = useRef<string | null>(null)
  /** Permission requests awaiting an answer — an answered one leaves at once */
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [mode, setModeState] = useState<ModeState>({ mode: 'confirm' })
  /**
   * A ref copy of `mode` — for `ensureSession`.
   *
   * The helper has to stay stable with `useCallback([])`: it is a dependency
   * of `send`, and if it were recreated on every render `send` would be
   * rebuilt as well. The ref breaks that dependency.
   */
  const modeRef = useRef<PermissionMode>(mode.mode)
  modeRef.current = mode.mode
  /** The attachments in the input field — cleared once sent */
  const [attachments, setAttachments] = useState<InputAttachment[]>([])
  /**
   * The in-flight session creation promise.
   *
   * There are two callers (`send` and `attach`) and both can arrive at once —
   * a file picked in an empty chat with Enter pressed straight after. Without
   * this, two sessions were created and one of them was lost.
   */
  const creating = useRef<Promise<string> | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const filePickerRef = useRef<HTMLInputElement>(null)
  // The id of the message currently awaiting a reply — WS events are matched by it
  const pending = useRef<string | null>(null)
  /**
   * The provider/model of the session being restored from the URL.
   *
   * A ref, because it races with the model loading effect: the two run in
   * parallel and which one finishes first is unknown. As state, the model
   * effect could have seen a stale value.
   */
  const restoredSession = useRef<{ provider?: string; model?: string } | null>(null)
  /**
   * A stable copy of `onSessionChanged`. App recreates it on every render — if
   * bound directly, `send` would be rebuilt on every render too and the
   * effects using it would re-run for nothing.
   */
  const sessionNotifier = useRef(onSessionChanged)
  sessionNotifier.current = onSessionChanged
  /** Is the restore finished — until then the "empty chat" screen is not shown */
  const [restoring, setRestoring] = useState(Boolean(openSession))

  // --- Restoring the conversation to open ---
  //
  // It runs in two cases:
  //   1) the page was opened with `#chat/<uuid>`;
  //   2) the user picked another conversation from the sidebar or the
  //      Conversations page — `openSession` changes and that conversation is
  //      reloaded.
  //
  // A session WE created never gets here: inside `send()` the `sessionId` is
  // already set and the equality check below stops the effect — otherwise a
  // brand new conversation would immediately be re-read from the database.
  useEffect(() => {
    // An empty chat — the clearing already happened in `newConversation()`
    if (!openSession) {
      setRestoring(false)
      return
    }
    // This conversation is already open (one we created, say) — no reload
    if (openSession === sessionIdRef.current) {
      setRestoring(false)
      return
    }

    let cancelled = false
    setRestoring(true)
    // Leftovers of the old conversation must not bleed into the new one.
    // `permissions` especially: another conversation's card awaiting an answer
    // would show up here.
    setMsgs([])
    setPermissions([])
    // The attachments too: the chips belonged to the PREVIOUS conversation and
    // cannot be sent in this one (the server rejects them by session)
    setAttachments([])
    pending.current = null
    setBusy(false)
    setStopping(false)

    void (async () => {
      const session = await fetchSession(openSession)
      if (cancelled) return

      // A stale URL or a deleted session — we quietly land on an empty chat
      if (!session) {
        sessionNotifier.current?.(null)
        setRestoring(false)
        return
      }

      // The model selection effect waits for this value
      restoredSession.current = { provider: session.provider, model: session.model }
      // If the models are already loaded (which is what happens when moving
      // between conversations) the model effect does not re-run — we pick here.
      // The list comes from the ref: the state may be stale for this closure,
      // while the ref always holds the current value.
      const match = modelsRef.current.find(
        (m) => m.provider === session.provider && m.id === session.model,
      )
      if (match) setSelected(match)

      // The project is restored the same way — the session is stored with a
      // `projectId`, but the UI state may be left over from a new chat. If the
      // list has not arrived yet the `restoredProject` ref holds on to it and
      // the project loading effect completes the selection there.
      restoredProject.current = session.projectId ?? null
      setProject(
        session.projectId
          ? (projectsRef.current.find((p) => p.id === session.projectId) ?? null)
          : null,
      )

      try {
        const [messages, modeState, pendingPermissions] = await Promise.all([
          fetchMessages(openSession),
          fetchMode(openSession).catch(() => null),
          // A conversation opened mid-stream may be waiting on a permission.
          // `chat.permission` has already gone by — this is the only place we
          // can recover it, otherwise the agent would sit waiting for an answer.
          fetchPendingPermissions(openSession).catch(() => []),
        ])
        if (cancelled) return
        setMsgs(messages.map(toMessage))
        setModeState(modeState ?? { mode: 'confirm' })
        setPermissions(pendingPermissions)
      } catch {
        // Even if the messages fail to load we open the session — the user can
        // carry on and the history may arrive on the next refresh
      }

      if (cancelled) return
      setSessionId(openSession)
      setRestoring(false)
    })()

    return () => {
      cancelled = true
    }
  }, [openSession])

  // --- Loading the models ---
  useEffect(() => {
    let cancelled = false
    fetchModels()
      .then((response) => {
        if (cancelled) return
        setModels(response.models)

        // For a conversation restored from the URL its own model wins. The
        // session's provider is locked and it cannot continue on another model.
        const restoring = restoredSession.current
        const sessionModel =
          restoring &&
          response.models.find(
            (m) => m.provider === restoring.provider && m.id === restoring.model,
          )

        // Is the previously selected one still available — if not we take the first
        const stored = readStoredModel()
        const found =
          sessionModel ||
          (stored &&
            response.models.find((m) => m.provider === stored.provider && m.id === stored.model)) ||
          response.models[0] ||
          null
        setSelected(found)

        if (response.models.length === 0) {
          setModelError(
            'No AI provider found. Set an API key as an environment variable or start Ollama.',
          )
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setModelError(error instanceof Error ? error.message : 'Could not load the models')
      })
      .finally(() => {
        if (!cancelled) setModelLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // --- Loading the projects ---
  //
  // On error we stay quiet: a project is an optional capability, and without
  // it the conversation still works (in its own folder).
  useEffect(() => {
    let cancelled = false
    fetchProjects()
      .then((list) => {
        if (cancelled) return
        setProjects(list)
        // If the restore effect finished before us it could not find the
        // project (the list was still empty) — we complete it here.
        const awaited = restoredProject.current
        if (awaited) {
          const found = list.find((p) => p.id === awaited)
          if (found) setProject(found)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // --- WS: listening to the reply stream ---
  //
  // TWO LAYERS OF PROTECTION (session isolation):
  //   1) `sub.sessionId` is sent to the server — it does not send another
  //      session's events at all (the `watchSession` effect below);
  //   2) the `sessionId` of an event that arrives anyway is still checked.
  // The second is not redundant: until the session exists (while the first
  // message is being sent) the filter may not be set yet, and there is a short
  // window during a reconnect too. A server bug must not surface in the UI as
  // someone else's text.
  useEffect(() => {
    ws.connect()
    const unsubscribe = ws.subscribe(['chat'])
    const unwatch = ws.watch((event) => {
      // A session-scoped chat event belonging to another conversation is
      // ignored. `sessionIdRef` is used (not the state): this listener
      // registers once and would close over stale state.
      if ('sessionId' in event && event.type.startsWith('chat.')) {
        const current = sessionIdRef.current
        if (current !== null && event.sessionId !== current) return
      }

      switch (event.type) {
        case 'chat.delta':
          setMsgs((m) =>
            m.map((x) => (x.id === event.messageId ? { ...x, text: x.text + event.delta } : x)),
          )
          break

        case 'chat.tool':
          // It arrives several times with the same `id`: running → done. We
          // replace the existing card, or append it if there is none.
          setMsgs((m) =>
            m.map((x) => {
              if (x.id !== event.messageId) return x
              const existing = x.toolCards ?? []
              const index = existing.findIndex((t) => t.id === event.tool.id)
              const next =
                index >= 0
                  ? existing.map((t, i) => (i === index ? event.tool : t))
                  : [...existing, event.tool]
              return { ...x, toolCards: next }
            }),
          )
          break

        case 'chat.permission':
          setPermissions((r) =>
            r.some((s) => s.id === event.request.id) ? r : [...r, event.request],
          )
          break

        case 'chat.classifier':
          // The label is now written onto the card by the SERVER (it comes with
          // `chat.tool` and lands in the database as well); this only covers the
          // in-between state: if the classifier event arrives before the card's
          // next update, the label shows up here immediately. Both write the
          // same value, so the overlap does no harm.
          setMsgs((m) =>
            m.map((x) => {
              if (x.id !== event.messageId || !x.toolCards?.length) return x
              const cards = [...x.toolCards]
              const last = cards.length - 1
              cards[last] = { ...cards[last]!, classifier: event.verdict }
              return { ...x, toolCards: cards }
            }),
          )
          break

        case 'chat.mode':
          setModeState(event.state)
          break

        case 'chat.status':
          // A FALLBACK PATH. `chat.status` is NOT FILTERED by session, i.e.
          // unlike `chat.permission` it always gets through. If the server says
          // "awaiting permission" and we have no card, then `chat.permission`
          // was lost on the way (the session filter is not set yet, the WS is
          // reconnecting). We ask for the request ourselves.
          //
          // Without this the agent would wait 5 minutes for an answer and then
          // be denied — while the user saw nothing of what was going on.
          if (event.status === 'awaiting-permission' && event.sessionId === sessionIdRef.current) {
            const awaitedSession = event.sessionId
            void fetchPendingPermissions(awaitedSession)
              .then((requests) => {
                // The conversation may have changed while the answer was in flight
                if (sessionIdRef.current !== awaitedSession) return
                setPermissions((r) => {
                  const fresh = requests.filter((s) => !r.some((m) => m.id === s.id))
                  return fresh.length > 0 ? [...r, ...fresh] : r
                })
              })
              .catch(() => undefined)
          }
          break

        case 'chat.done':
          setMsgs((m) => m.map((x) => (x.id === event.messageId ? { ...x, streaming: false } : x)))
          setPermissions([])
          if (pending.current === event.messageId) {
            pending.current = null
            setBusy(false)
          }
          break

        case 'chat.error':
          setMsgs((m) =>
            m.map((x) =>
              x.id === event.messageId ? { ...x, streaming: false, error: event.error } : x,
            ),
          )
          setPermissions([])
          if (pending.current === event.messageId) {
            pending.current = null
            setBusy(false)
          }
          break

        // The reply stopped on the provider's quota, and the platform has
        // already booked the continuation. This arrives INSTEAD of
        // `chat.error` — the stream is over either way, so the message is
        // closed exactly as an error would close it, but shown as a notice.
        case 'chat.scheduled':
          setMsgs((m) =>
            m.map((x) =>
              x.id === event.messageId ? { ...x, streaming: false, scheduled: event.reason } : x,
            ),
          )
          setPermissions([])
          if (pending.current === event.messageId) {
            pending.current = null
            setBusy(false)
          }
          break

        default:
          // The other channels do not concern this page
          break
      }
    })
    return () => {
      unsubscribe()
      unwatch()
    }
  }, [])

  // When the session changes: we update the ref and tell the server which
  // session we are watching. After that, another window's conversation events
  // do not reach this connection at all.
  useEffect(() => {
    sessionIdRef.current = sessionId
    ws.watchSession(sessionId ?? undefined)
  }, [sessionId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [msgs])

  // The textarea height follows the text. `auto` first — otherwise scrollHeight
  // never shrinks and the field stays tall even after lines are deleted.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`
  }, [input])

  /**
   * Is a stream running on the server for this conversation.
   *
   * A source INDEPENDENT of `busy`: `busy` is only switched on when this window
   * calls `send()` and it is lost on a page refresh. The server state (GET
   * /chat/running + `chat.status` events) is still correct after a refresh and
   * also shows a stream started from another window.
   */
  const runningOnServer = sessionId !== null && running?.[sessionId] !== undefined

  // The "stopping" flag is cleared once the server confirms — after that the
  // button works again (when the user sends a new message, say). It is also
  // cleared when the session changes: the flag belonged to the old conversation.
  useEffect(() => {
    if (!runningOnServer) setStopping(false)
  }, [runningOnServer, sessionId])

  /**
   * Guarantees a session exists — creates one if it does not and returns its id.
   *
   * THERE ARE TWO CALLERS: sending a message and attaching a file. The second
   * is why it is split out — an attachment lands in the session folder right
   * away, so the session may be needed BEFORE any text is written.
   *
   * COPYING THIS BY HAND IS RISKY: the sequence below (the ref first, then
   * `watchSession`, then `sessionNotifier`) is built against the races
   * described in the comments. Drop a single line in a second copy and the
   * reply quietly disappears.
   *
   * The `creating` ref prevents TWO SESSIONS being created AT ONCE: if the user
   * picks two files back to back in an empty chat (or a paste and a send land
   * together), two `POST /chat/sessions` went out and one of them was lost.
   */
  const ensureSession = useCallback(
    async (title: string): Promise<string> => {
      const existing = sessionIdRef.current
      if (existing) return existing
      // If a creation is already in flight we wait for it instead of starting a second
      if (creating.current) return creating.current

      const work = (async () => {
        // The project is bound here ONCE — after this the session is locked
        // together with its work directory
        const session = await createSession(title.slice(0, 60), projectRef.current?.id)
        const sid = session.id
        setSessionId(sid)
        // The ref is updated IMMEDIATELY — without waiting for the effect below.
        //
        // Why it matters: `sessionNotifier` changes App's `openSession`, i.e.
        // the restore effect (above) runs. Its "a session we created" guard
        // looks at exactly this ref, and the effect that updates the ref runs
        // LATER in declaration order. The guard would therefore see the old
        // `null`, let it through, and the empty reply message that was just
        // added would be wiped by `setMsgs([])` — the `chat.delta` events
        // arriving afterwards would find no message to attach to and the reply
        // only appeared after a page refresh (from the database).
        sessionIdRef.current = sid
        // The filter is set immediately too — BEFORE `sendMessage`. Otherwise,
        // once the server starts streaming the reply, the first deltas aimed at
        // an unfiltered connection would be stuck in transit until the effect
        // ran. `watchSession` guards against repetition itself (the same id
        // returns straight away), so the effect below does no extra work.
        ws.watchSession(sid)
        // We write it into the URL — from now on a page refresh restores the
        // conversation
        sessionNotifier.current?.(sid)
        // The mode selected before the session existed is handed to the server.
        //
        // BOTH values are sent, not just `auto`. The server default is
        // `confirm` too, so passing quietly would have "looked like it worked"
        // — but then the mode the UI showed and the mode the server actually
        // applied would NEVER have been compared. Now the response confirms the
        // state (or corrects it).
        try {
          setModeState(await setModeRequest(sid, modeRef.current))
        } catch {
          // If the mode cannot be set, the server default (confirm) stays in
          // force — the safe side. The toggle reflects that state.
          setModeState({ mode: 'confirm' })
        }
        return sid
      })()

      // The PROMISE is stored, not the result: a second call arriving at that
      // moment awaits the very same promise and no second session is created.
      creating.current = work
      try {
        return await work
      } finally {
        // Cleared on failure too — so the next attempt starts over
        creating.current = null
      }
    },
    [],
  )

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim()
      // With an attachment it can be sent without text: dropping an image and
      // writing nothing is natural (and the server allows it too).
      const ready = attachments.filter((a) => a.record)
      if (!text && ready.length === 0) return
      // `runningOnServer` blocks as well: after a refresh `busy` is false while
      // the stream carries on in the background. Without it, a new message sent
      // would quietly abort the old stream on the server (at the top of the
      // reply streamer) — and the user would not understand why the reply was
      // cut in half.
      if (busy || runningOnServer || !selected) return
      // If a file is still uploading we wait: otherwise the user would think
      // "I attached a file" while it never got sent.
      if (attachments.some((a) => !a.record && !a.error)) return

      setBusy(true)
      setMsgs((m) => [
        ...m,
        {
          id: `u-${crypto.randomUUID()}`,
          role: 'user',
          text,
          attachments: ready.map((a) => a.record!),
        },
      ])

      try {
        // If there is no session yet we create one on the first message. When a
        // file is attached it already exists (a session is required to attach)
        // and this call returns immediately.
        const sid = await ensureSession(text || (ready[0]?.name ?? 'new chat'))

        const response = await sendMessage(
          sid,
          text,
          { provider: selected.provider, model: selected.id },
          ready.map((a) => a.record!.id),
        )

        // Cleared AFTER success. `setInput('')` used to sit before the request
        // and every 400 (the vision guard, say) cost the user their text — they
        // had to type it again.
        setInput('')
        setAttachments([])

        pending.current = response.messageId
        setMsgs((m) => [
          ...m,
          { id: response.messageId, role: 'assistant', text: '', streaming: true },
        ])
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.detail
              ? `${error.message} — ${error.detail}`
              : error.message
            : error instanceof Error
              ? error.message
              : 'Unknown error'
        // We remove the optimistic user message: it NEVER REACHED the server,
        // so leaving it in the chat would be a lie (it would disappear on a
        // page refresh anyway). The text goes back into the field.
        setMsgs((m) => [
          ...m.slice(0, -1),
          { id: `e-${crypto.randomUUID()}`, role: 'assistant', text: '', error: message },
        ])
        setInput(text)
        setBusy(false)
      }
    },
    [attachments, busy, input, runningOnServer, ensureSession, selected],
  )

  /**
   * Attaches files: shows the chips at once, then uploads.
   *
   * THE SESSION IS CREATED HERE (if there is none): the file goes straight into
   * the session folder, so waiting for text to be typed is not an option. An
   * empty session left behind is a normal state on the platform — the
   * Conversations list singles them out by `messageCount: 0`.
   *
   * IT DOES NOT THROW: every file shows its error on its own chip and the user
   * can remove it and try again. One file's failure does not stop the rest.
   */
  const attach = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return

      // The vision guard — the SERVER checks this too (`/chat/send`); this is
      // only an early warning: better the user knows straight away than
      // uploading an image and getting a 400 when they send.
      if (selected && !selected.vision && files.some((f) => f.type.startsWith('image/'))) {
        toast(
          `${selected.name} cannot see images — pick a model that supports vision`,
          'error',
        )
        return
      }

      const fresh = toInputAttachments(files)
      setAttachments((a) => [...a, ...fresh])

      let sid: string
      try {
        sid = await ensureSession(files[0]!.name || 'attachment')
      } catch {
        setAttachments((a) =>
          a.map((x) =>
            fresh.some((f) => f.localId === x.localId)
              ? { ...x, error: 'could not create the session' }
              : x,
          ),
        )
        return
      }

      // The files are sent TOGETHER (a single request): so the server checks
      // the count limit as a whole and the network queue stays shorter.
      try {
        const records = await uploadAttachment(sid, files)
        setAttachments((a) =>
          a.map((x) => {
            const index = fresh.findIndex((f) => f.localId === x.localId)
            const record = index >= 0 ? records[index] : undefined
            // The server returns as many as were sent and in the SAME ORDER —
            // this pairing relies on that
            return record ? { ...x, record, name: record.originalName } : x
          }),
        )
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.detail
              ? `${error.message} — ${error.detail}`
              : error.message
            : 'upload failed'
        setAttachments((a) =>
          a.map((x) =>
            fresh.some((f) => f.localId === x.localId) ? { ...x, error: message } : x,
          ),
        )
      }
    },
    [ensureSession, selected, toast],
  )

  /**
   * Removes a chip.
   *
   * If there is a server record it is deleted too (along with the file). A chip
   * that never uploaded, or failed, is purely local — no request goes out.
   */
  const removeChip = useCallback((chip: InputAttachment) => {
    setAttachments((a) => a.filter((x) => x.localId !== chip.localId))
    if (!chip.record) return
    // We do not wait for the result: the chip is already gone, and if the
    // record is left behind the orphan cleanup picks it up after 24 hours
    // (`orchestrator.ts`).
    void removeAttachmentRequest(chip.record.id).catch(() => undefined)
  }, [])

  /**
   * Catches files coming from the clipboard (Ctrl+V).
   *
   * ON THE TEXTAREA, NOT ON `document`: a document-level listener grabbed the
   * image from anywhere on the page (the Terminal, Skills, the ModelPicker
   * search) and attached it to the chat. A textarea states the intent clearly.
   */
  function paste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    // The `kind !== 'file'` check IS REQUIRED: `items` is not empty when plain
    // text is copied either (string kinds arrive). Without it a text paste
    // would be blocked as well.
    const files: File[] = []
    for (const element of event.clipboardData.items) {
      if (element.kind !== 'file') continue
      const file = element.getAsFile()
      if (file) files.push(file)
    }
    // No file — the browser inserts the text itself, we stay out of the way
    if (files.length === 0) return
    event.preventDefault()
    void attach(files)
  }

  /**
   * Creates a new project and adds it to the list.
   *
   * The error is displayed inside the picker — which is why it is not caught here.
   */
  const createProject = useCallback(async (name: string): Promise<Project> => {
    const fresh = await createProjectRequest(name)
    setProjects((list) => [fresh, ...list])
    return fresh
  }, [])

  async function grantPermission(request: PermissionRequest, answer: PermissionAnswer) {
    // An answered card disappears from the chat straight away — we do not wait
    // for the server to confirm. Otherwise a long stream would pile up
    // "✓ Permission granted" blocks and push the actual reply text down. The
    // outcome of the action shows on the tool card anyway.
    setPermissions((r) => r.filter((s) => s.id !== request.id))
    try {
      await sendPermissionAnswer(request.sessionId, request.id, answer)
    } catch (error) {
      // If it fails to send the user has to know — the agent is waiting. We put
      // the card back so they can try again.
      toast(
        error instanceof ApiError
          ? `Could not send the answer: ${error.message}`
          : 'Could not send the permission answer',
        'error',
      )
      setPermissions((r) => (r.some((s) => s.id === request.id) ? r : [...r, request]))
    }
  }

  async function changeMode(next: PermissionMode) {
    if (!sessionId) {
      // No session yet — we remember the choice and apply it on the first message
      setModeState({ mode: next })
      return
    }
    const previous = mode
    setModeState({ mode: next }) // shown immediately
    try {
      setModeState(await setModeRequest(sessionId, next))
    } catch (error) {
      setModeState(previous)
      toast(
        error instanceof ApiError
          ? `Could not change the mode: ${error.message}`
          : 'Could not change the mode',
        'error',
      )
    }
  }

  async function stop() {
    if (!sessionId) return
    // The button goes away immediately — there is a short window until the
    // server broadcasts `chat.status: done` (and App's map updates), and
    // without this the button looked stuck even after being pressed.
    setStopping(true)
    try {
      await stopStream(sessionId)
    } catch {
      // even if stopping fails the UI must not block
    }
    pending.current = null
    setBusy(false)
    setMsgs((m) => m.map((x) => (x.streaming ? { ...x, streaming: false } : x)))
  }

  // "What are we building?" is not shown while restoring — otherwise an empty
  // screen would flash by until the saved conversation loads
  const empty = msgs.length === 0 && !restoring
  const locked = sessionId !== null

  /**
   * Should the "Stop" button be visible.
   *
   * Both sources are needed, neither alone is enough:
   *   - `busy` — the short window where the message has been sent but the
   *     server has not broadcast `chat.status` yet; without it the button would
   *     flicker into "Send" for a moment;
   *   - `runningOnServer` — the state after a refresh, where `busy` is already
   *     `false`.
   */
  const canStop = (busy || runningOnServer) && !stopping

  /** At least one file is still uploading */
  const uploading = attachments.some((a) => !a.record && !a.error)

  /**
   * Should the send button be enabled.
   *
   * Text OR a ready attachment is enough (the server agrees: `chat-send.ts`
   * accepts empty text when there is an attachment). Until the upload finishes
   * it is blocked.
   */
  const canSend =
    !uploading && (input.trim().length > 0 || attachments.some((a) => a.record))

  /**
   * Prepares the window for a new conversation.
   *
   * The background session is NOT STOPPED — it keeps working and can be
   * reopened from the Conversations list (or the Agents page). Only this window
   * is cleared here.
   */
  function newConversation() {
    setSessionId(null)
    sessionNotifier.current?.(null)
    setMsgs([])
    setPermissions([])
    // The mode choice is kept, but the "turned off" reason is cleared
    setModeState((s) => ({ mode: s.mode }))
    // THE PROJECT CHOICE IS KEPT DELIBERATELY: "open a new chat inside the
    // project" is the most commonly needed path. To move to another project the
    // picker is now unlocked.
    //
    // The ref is cleared though: it is the awaited project of a session being
    // restored, and a new chat has nothing to await. Otherwise a late-arriving
    // project list would override the choice the user had just made.
    restoredProject.current = null
    pending.current = null
    // The attachments belong to the PREVIOUS session — chips left in a new chat
    // would be a lie (they do not bind to the session created next). The
    // records stay on the server and the orphan cleanup collects them.
    setAttachments([])
    creating.current = null
    setBusy(false)
    setStopping(false)
  }

  // The sidebar's "New chat" button. It must not fire on the initial value (0)
  // — only on real presses.
  const previousSignal = useRef(newConversationSignal)
  useEffect(() => {
    if (newConversationSignal === undefined) return
    if (previousSignal.current === newConversationSignal) return
    previousSignal.current = newConversationSignal
    newConversation()
    // newConversation is recreated on every render — we depend on the signal only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newConversationSignal])

  return (
    <div className={`flex h-full flex-col ${pro ? '' : 'mx-auto w-full max-w-3xl'}`}>
      {/* There is no title row at the top of the chat — the conversation itself
          is what shows. "New chat" lives in the sidebar (pro) and in the
          control panel below (in both modes). The project name is in that panel
          too, and the full folder path in its hover popup. */}

      <div className="thin-scroll flex-1 overflow-y-auto px-4 pt-6 pb-4">
        {empty && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="font-display text-3xl font-semibold tracking-tight">
              What are we building<span className="text-lazur">?</span>
            </div>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
              Pick a model before starting the chat. Models come from the providers configured
              on your machine — local Ollama as well as subscription-based ones.
            </p>
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-5">
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="rise-in flex flex-col items-end gap-1.5">
                {/* The attachments sit ABOVE the text — the user picked them
                    first, then wrote. No remove button on the chip: a sent file
                    is part of the conversation history. */}
                {m.attachments && m.attachments.length > 0 && (
                  <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
                    {m.attachments.map((a) => (
                      <AttachmentChip key={a.id} attachment={a} name={a.originalName} />
                    ))}
                  </div>
                )}
                {m.text && (
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-panel2 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                    {m.text}
                  </div>
                )}
              </div>
            ) : (
              <div key={m.id} className="rise-in">
                {m.toolCards?.map((t) => (
                  <ToolCardView key={t.id} tool={t} />
                ))}
                {m.text && (
                  <>
                    <Markdown text={m.text} />
                    {m.streaming && (
                      <span className="cursor-blink -mt-1 inline-block text-lazur">▍</span>
                    )}
                  </>
                )}
                {!m.text && m.streaming && (
                  <p className="text-[15px] text-faint">
                    <span className="cursor-blink text-lazur">▍</span>
                  </p>
                )}
                {m.error && (
                  <div className="mt-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-coral">
                    {m.error}
                  </div>
                )}
                {/* Not the error colour: nothing here needs the user to act */}
                {m.scheduled && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-lazur-dim/40 bg-panel px-3 py-2 text-sm text-muted">
                    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 stroke-lazur" fill="none" strokeWidth="1.5">
                      <path d="M10 5v5l3 2M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />
                    </svg>
                    <span className="leading-relaxed">{m.scheduled}</span>
                  </div>
                )}
              </div>
            ),
          )}

          {/* The permission requests — at the END of the conversation, on their
              own. They used to sit inside the streaming reply message
              (`m.streaming`). That was a source of silent loss: if a request
              arrived BEFORE that message was added (which is what happens on
              the first message of a new session — the session is created first,
              the reply message added after) there was nothing to attach to and
              the card was never drawn at all. The agent then just kept waiting
              for an answer. Now the card is independent of the messages. */}
          {permissions.map((request) => (
            <PermissionCard
              key={request.id}
              request={request}
              onAnswer={(answer) => void grantPermission(request, answer)}
            />
          ))}

          {/* If auto turned itself off — the reason and a re-enable button */}
          {mode.mode === 'confirm' && mode.reason && (
            <ModeCard reason={mode.reason} onReEnable={() => void changeMode('auto')} />
          )}

          <div ref={endRef} />
        </div>
      </div>

      <div className="px-4 pb-5">
        <div className="mx-auto max-w-3xl">
          {empty && !modelLoading && models.length > 0 && (
            <div className="mb-3 flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] text-muted transition hover:border-lazur-dim hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* The attached files — ABOVE the form, so they do not squeeze the
              input field */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.localId}
                  attachment={a.record}
                  name={a.name}
                  error={a.error}
                  onRemove={() => removeChip(a)}
                />
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
            className="flex items-end gap-2 rounded-2xl border border-line bg-panel px-4 py-2 transition focus-within:border-lazur-dim"
          >
            {/* The file picker — hidden, the button opens it. Attaching is part
                of the INPUT, hence it lives inside the form; the model, mode and
                project are session settings and live in the capsule below. */}
            <input
              ref={filePickerRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                // The field is cleared: picking the same file a second time
                // should fire `change` too (otherwise the browser stays silent)
                e.target.value = ''
                void attach(files)
              }}
            />
            <button
              type="button"
              onClick={() => filePickerRef.current?.click()}
              disabled={!selected}
              title="Attach a file or image (you can also paste an image with Ctrl+V)"
              aria-label="Attach file"
              className="mb-1 shrink-0 text-base text-faint transition enabled:hover:text-lazur disabled:cursor-not-allowed disabled:opacity-40"
            >
              📎
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={paste}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter is a new line. If an IME (a Chinese
                // keyboard, say) has not confirmed the word yet we stay out of it.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={1}
              placeholder={selected ? 'Type your message…' : 'Pick a model first…'}
              aria-label="Message"
              disabled={!selected}
              // `focus-outside`: the ring is drawn by the form wrapper (focus-within)
              className="thin-scroll focus-outside flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-faint disabled:cursor-not-allowed"
            />
            {canStop ? (
              <button
                type="button"
                onClick={() => void stop()}
                className="mb-0.5 shrink-0 rounded-xl border border-line px-4 py-1.5 text-sm text-muted transition hover:border-coral hover:text-coral"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                // With an attachment it can be sent without text. While a file
                // is still uploading it is blocked: otherwise the user would
                // think "I attached a file" while it never got sent.
                disabled={!selected || !canSend}
                title={uploading ? 'File is uploading…' : undefined}
                className="mb-0.5 shrink-0 rounded-xl bg-lazur-dim px-4 py-1.5 text-sm font-semibold text-bg transition enabled:hover:brightness-110 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </form>

          <div className="mt-2 flex items-center justify-between gap-3">
            {/* All three pickers in one capsule — the row reads as a whole and
                it is felt that these are related settings */}
            <div className="flex min-w-0 items-center gap-1 rounded-xl border border-line/60 bg-panel/40 p-1">
              <ModelPicker
                models={models}
                selected={selected}
                onSelect={setSelected}
                locked={locked}
                loading={modelLoading}
                error={modelError}
              />
              <span className="h-4 w-px shrink-0 bg-line/60" aria-hidden />
              <ModeToggle
                state={mode}
                onChange={(m) => void changeMode(m)}
                busy={canStop}
              />
              <span className="h-4 w-px shrink-0 bg-line/60" aria-hidden />
              <ProjectPicker
                projects={projects}
                selected={project}
                onSelect={setProject}
                onCreate={createProject}
                locked={locked}
              />
            </div>
            {/* Once a conversation has started — moving to a new one. In the
                simple mode this is the only way (the sidebar only exists in
                pro). The current session is not stopped: it keeps running in
                the background. */}
            {locked && (
              <button
                onClick={newConversation}
                title="The current chat keeps running in the background"
                className="shrink-0 font-mono text-[11px] text-faint transition hover:text-lazur"
              >
                + new chat
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
