// A file or image attached to the chat — a small chip.
//
// It appears in three states:
//   uploading — a blinking dot, no remove button (there is no id yet);
//   uploaded  — a thumbnail for images, an icon + size for files;
//   error     — coral text, so the user can remove it and try again.
//
// The same chip is used AFTER sending (in the conversation history), but
// without the remove button: a sent file is part of the conversation and the
// agent has already seen it — rewriting history backwards would create a false
// context.

import type { ChatAttachment } from '@barpo/shared'
import { attachmentUrl } from '../lib/api'

interface Props {
  /** The uploaded record. `undefined` — still uploading, or an error. */
  attachment?: ChatAttachment
  /** Name to display — needed even while the upload is in flight */
  name: string
  /** Upload error */
  error?: string
  /** If omitted the remove button is hidden (a chip in the history) */
  onRemove?: () => void
}

/** Converts the size into a human-readable form */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function AttachmentChip({ attachment, name, error, onRemove }: Props) {
  const isImage = attachment?.kind === 'image'
  const uploading = !attachment && !error

  return (
    <div
      className={`flex max-w-[240px] items-center gap-2 rounded-lg border bg-panel px-2 py-1.5 ${
        error ? 'border-coral/50' : 'border-line'
      }`}
      title={error ? `${name} — ${error}` : name}
    >
      {isImage ? (
        <img
          src={attachmentUrl(attachment.id)}
          alt={attachment.originalName}
          loading="lazy"
          className="size-8 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="shrink-0 text-sm" aria-hidden>
          {error ? '⚠' : uploading ? '' : '📄'}
        </span>
      )}

      {uploading && (
        <span className="pulse-dot inline-block size-1.5 shrink-0 rounded-full bg-gold" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-ink">{name}</div>
        <div className={`text-[10px] ${error ? 'text-coral' : 'text-faint'}`}>
          {error ?? (attachment ? sizeText(attachment.size) : 'uploading…')}
        </div>
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${name} — remove attachment`}
          className="shrink-0 text-faint transition hover:text-coral"
        >
          ×
        </button>
      )}
    </div>
  )
}
