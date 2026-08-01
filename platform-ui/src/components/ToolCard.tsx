// A tool call made by the agent — a card inside the chat.
//
// It has three looks: running (blinking dot), done (✓), error or denied
// (coral). A long result stays collapsed and opens on click — so the chat
// stream does not drown in long bash output.
//
// For `edit` the diff is rendered separately: added lines in mint, removed
// ones in coral.

import { useState } from 'react'
import type { PermissionOrigin, ToolCall } from '@barpo/shared'

/** Maximum number of lines shown while collapsed */
const SHORT_LINES = 6

/**
 * How the action was approved — one line at the bottom of the card.
 *
 * This is not diagnostics but an ACCOUNTABILITY trail: when the user later
 * asks "why was this command run?", the answer is right here.
 *
 * Safe actions (`read`, `ls`… inside the work directory) get NO such line at
 * all: they never enter the permission layer, so there is no decision. The
 * presence of the line itself means "this action went through a check".
 */
const permissionText: Record<PermissionOrigin, string> = {
  always: 'executed because "always" was selected',
  auto: 'auto mode: the classifier allowed it',
  'auto-block': 'auto mode: blocked by the classifier',
  user: 'you granted permission',
  'user-always': 'you granted "always" permission',
  denied: 'you denied it',
  timeout: 'no answer — timed out and was denied',
  cancelled: 'answer cancelled — the action was not executed',
  forbidden: 'on the hard denylist — never asked of anyone',
}

const nameIcon: Record<string, string> = {
  read: '📖',
  write: '✍️',
  edit: '✏️',
  bash: '⌘',
}

function statusStyle(status: ToolCall['status']): { color: string; icon: string; text: string } {
  switch (status) {
    case 'running':
      return { color: 'text-gold', icon: '', text: 'running…' }
    case 'done':
      return { color: 'text-mint', icon: '✓', text: '' }
    case 'denied':
      return { color: 'text-gold', icon: '⊘', text: 'permission denied' }
    case 'error':
      return { color: 'text-coral', icon: '✕', text: 'error' }
  }
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="thin-scroll overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => {
        const color = line.startsWith('+')
          ? 'text-mint'
          : line.startsWith('-')
            ? 'text-coral'
            : line.startsWith('@')
              ? 'text-lazur'
              : 'text-muted'
        return (
          <div key={i} className={color}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export default function ToolCardView({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false)
  const style = statusStyle(tool.status)

  const result = tool.result ?? ''
  const lines = result ? result.split('\n') : []
  const isLong = lines.length > SHORT_LINES
  const visible = open || !isLong ? result : lines.slice(0, SHORT_LINES).join('\n')

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-line bg-bg font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span aria-hidden>{nameIcon[tool.name] ?? '•'}</span>
        <span className="text-lazur">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-faint" title={tool.args}>
          {tool.args}
        </span>
        <span className={`flex shrink-0 items-center gap-1.5 ${style.color}`}>
          {tool.status === 'running' && (
            <span className="pulse-dot inline-block size-1.5 rounded-full bg-gold" aria-hidden />
          )}
          {style.icon && <span aria-hidden>{style.icon}</span>}
          {style.text && <span>{style.text}</span>}
        </span>
      </div>

      {tool.detail?.diff ? (
        <DiffView diff={tool.detail.diff} />
      ) : (
        visible && (
          <div className="px-3 py-2 text-muted">
            <pre className="thin-scroll overflow-x-auto whitespace-pre-wrap break-words">
              {visible}
            </pre>
            {tool.detail?.truncated && (
              <div className="mt-1 text-faint">[output truncated]</div>
            )}
          </div>
        )
      )}

      {isLong && !tool.detail?.diff && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full border-t border-line px-3 py-1.5 text-left text-faint transition hover:text-lazur"
        >
          {open ? '▴ collapse' : `▾ ${lines.length - SHORT_LINES} more lines`}
        </button>
      )}

      {tool.classifier && (
        <div
          className={`flex items-start gap-1.5 border-t border-line px-3 py-1.5 text-[11px] ${
            tool.classifier.verdict === 'allow' ? 'text-faint' : 'text-gold'
          }`}
        >
          <span aria-hidden>{tool.classifier.verdict === 'allow' ? '✓' : '⊘'}</span>
          <span className="min-w-0 flex-1">{tool.classifier.note}</span>
        </div>
      )}

      {/* Both this and the classifier note can appear at once: one says "why"
          (the note), this one says "who decided" (the origin). */}
      {tool.permission && (
        <div
          className={`flex items-start gap-1.5 border-t border-line px-3 py-1.5 text-[11px] ${
            tool.permission.granted ? 'text-faint' : 'text-gold'
          }`}
          title={tool.permission.pattern ? `pattern: ${tool.permission.pattern}` : undefined}
        >
          <span aria-hidden>{tool.permission.granted ? '🔓' : '🔒'}</span>
          <span className="min-w-0 flex-1">{permissionText[tool.permission.origin]}</span>
        </div>
      )}
    </div>
  )
}
