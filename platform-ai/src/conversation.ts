// A plain text conversation stream — no tools.
//
// It turns pi-ai's rich event stream (text_start, thinking_delta, toolcall_end,
// ...) into the three simple ones the platform needs: delta / done / error.
// Tools are added at the next stage — at that point `toolcall` events and
// `Context.tools` are added here, and the callers do not change.
//
// Errors are not thrown: the stream ends with `{ kind: 'error' }`. The reason —
// for the caller (the orchestrator) an error is part of the answer too: it has
// to be written into the chat history and sent to the UI over WS.

import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai'
import type { ModelChoice } from '@barpo/shared'
import { modelsCollection } from './detect.ts'

export interface ConversationMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface Usage {
  input: number
  output: number
  cost: number
}

export type ConversationEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; text: string; usage: Usage }
  | { kind: 'error'; message: string }

/**
 * The system prompt for a conversation without tools.
 *
 * The language rule is the same as in `AGENT_SYSTEM_PROMPT`: answer in whatever
 * language the user writes in, with Uzbek only as the fallback. The two streams
 * have to feel the same to one and the same user, which is why the voice rules
 * are repeated here as well, in shortened form.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are the AI assistant of this platform. You have no separate product',
  'name — never introduce yourself with the name of a product or company.',
  '',
  'Reply in THE SAME LANGUAGE the user writes in, detected fresh on every',
  'message. If the language is unclear, reply in Uzbek.',
  '',
  'Write like a person talking to a colleague: natural, no padding. Match the',
  'length of your answer to the question. Do not advertise yourself by listing',
  'capabilities, do not open with filler like "Sure!", do not use emoji. Never',
  'state something you have not checked as if it were fact — say you do not',
  'know.',
  '',
  'In this mode you have no tools: you cannot read files, change them, or run',
  'commands. If asked to do such a thing, say briefly that you cannot.',
].join('\n')

export interface ConversationOptions {
  systemPrompt?: string
  signal?: AbortSignal
}

/**
 * Returns the LLM's answer as a stream.
 * If no model is found or the request fails — an `error` event.
 */
export async function* conversationStream(
  choice: ModelChoice,
  messages: ConversationMessage[],
  options?: ConversationOptions,
): AsyncGenerator<ConversationEvent> {
  let model
  try {
    const models = await modelsCollection()
    model = models.getModel(choice.provider, choice.model)
    if (!model) {
      yield {
        kind: 'error',
        message: `Model not found: ${choice.provider}/${choice.model}. Check that the provider is configured.`,
      }
      return
    }

    const context: Context = {
      systemPrompt: options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      messages: convertMessages(messages),
      // tools are DELIBERATELY not given — there are no tools at this stage
    }

    const stream = models.stream(model, context, { signal: options?.signal })

    let collected = ''
    for await (const event of stream) {
      switch (event.type) {
        case 'text_delta':
          collected += event.delta
          yield { kind: 'delta', text: event.delta }
          break

        case 'done':
          yield { kind: 'done', text: collected, usage: readUsage(event.message) }
          return

        case 'error':
          yield {
            kind: 'error',
            message: errorMessage(event.error, event.reason === 'aborted'),
          }
          return

        default:
          // thinking_*, toolcall_*, text_start/end, start — ignored at this
          // stage
          break
      }
    }

    // The stream ended without giving either `done` or `error` — this should
    // not happen, but we close it so the UI does not wait forever
    yield { kind: 'done', text: collected, usage: { input: 0, output: 0, cost: 0 } }
  } catch (error) {
    yield { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

function convertMessages(messages: ConversationMessage[]): Message[] {
  const time = Date.now()
  return messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.text, timestamp: time }
      : ({
          role: 'assistant',
          content: [{ type: 'text', text: m.text }],
          // Which model wrote the answers in the history does not matter —
          // pi-ai fills these fields in only for new answers.
          api: 'openai-completions',
          provider: 'history',
          model: 'history',
          usage: emptyUsage(),
          stopReason: 'stop',
          timestamp: time,
        } satisfies AssistantMessage),
  )
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function readUsage(message: AssistantMessage): Usage {
  return {
    input: message.usage.input,
    output: message.usage.output,
    cost: message.usage.cost.total,
  }
}

function errorMessage(message: AssistantMessage, cancelled: boolean): string {
  if (cancelled) return 'Request cancelled'
  return message.errorMessage ?? 'Unknown error'
}
