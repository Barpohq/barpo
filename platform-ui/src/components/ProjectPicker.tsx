// Project picker — at the bottom of the chat, next to the model picker.
//
// A project = a named work directory. When a conversation is attached to a
// project the agent's tools run in that folder and every conversation of that
// project sees the same set of files. Without one the conversation stays in
// its own temporary folder.
//
// The choice is ONLY available before the conversation starts: once the
// session exists the work directory is locked (the agent may already have
// created files there, and moving it mid-way would break the context). While
// locked the picker only displays the selected project's name.
//
// The list is loaded by the Chat page above and passed down here — one request
// serves both components.

import { useState } from 'react'
import type { Project } from '@platforma/shared'

interface Props {
  projects: Project[]
  selected: Project | null
  onSelect: (project: Project | null) => void
  /** Creates a new project and returns the created one */
  onCreate: (name: string) => Promise<Project>
  /** The session has started — the project can no longer change */
  locked?: boolean
}

/**
 * The full folder path, shown on hover.
 *
 * Instead of the browser's `title` attribute: that lags about a second, is
 * styled by the system and truncates a long path on its own. The path has to
 * be shown in full — knowing which folder the agent creates files in matters.
 *
 * `pointer-events-none`: the popup must not capture the mouse, otherwise the
 * button underneath becomes unclickable.
 */
function FolderPopup({ project }: { project: Project | null }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 hidden w-max max-w-[min(28rem,calc(100vw-3rem))] rounded-lg border border-line bg-panel px-2.5 py-1.5 shadow-xl group-hover:block"
    >
      {project ? (
        <>
          <span className="block font-mono text-[10px] tracking-widest text-faint uppercase">
            Working folder
          </span>
          {/* break-all: a long path must wrap rather than be cut off */}
          <span className="mt-0.5 block font-mono text-[11px] break-all text-lazur">
            {project.folder}
          </span>
        </>
      ) : (
        <span className="block text-[11px] text-muted">
          Not linked to a project — the chat runs in its own temporary folder
        </span>
      )}
    </span>
  )
}

export default function ProjectPicker({
  projects,
  selected,
  onSelect,
  onCreate,
  locked,
}: Props) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const label = selected ? `▣ ${selected.name}` : '▢ no project'

  async function create() {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    setError(null)
    try {
      const project = await onCreate(name)
      onSelect(project)
      setNewName('')
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the project')
    } finally {
      setCreating(false)
    }
  }

  // While locked the list does not open — only the state is shown. The full
  // folder path lives in the hover popup: the label carries just the name, but
  // knowing which folder the agent works in is still needed.
  if (locked) {
    return (
      <span className="group relative shrink-0">
        <span className="block rounded-lg border border-transparent px-2.5 py-1 font-mono text-[11px] text-faint">
          {label}
        </span>
        <FolderPopup project={selected} />
      </span>
    )
  }

  return (
    <div className="group relative shrink-0">
      {/* The popup only shows while the list is closed — otherwise the two overlap */}
      {!open && <FolderPopup project={selected} />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Project: ${selected?.name ?? 'none selected'}`}
        className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] transition ${
          selected
            ? 'border-lazur-dim text-lazur hover:brightness-110'
            : open
              ? 'border-lazur-dim bg-panel2 text-muted'
              : 'border-transparent text-faint hover:bg-panel2/60 hover:text-muted'
        }`}
      >
        {label}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-xl border border-line bg-panel p-2 shadow-xl">
          <div className="px-2 pb-1.5 text-[10px] font-semibold tracking-widest text-faint uppercase">
            Project
          </div>

          <button
            type="button"
            onClick={() => {
              onSelect(null)
              setOpen(false)
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-panel2/60 ${
              selected ? 'text-muted' : 'text-lazur'
            }`}
          >
            ▢ no project
          </button>

          <div className="thin-scroll max-h-48 overflow-y-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onSelect(p)
                  setOpen(false)
                }}
                title={p.folder}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-panel2/60 ${
                  selected?.id === p.id ? 'text-lazur' : 'text-muted'
                }`}
              >
                <span className="truncate">▣ {p.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-faint">
                  {p.chatCount ?? 0} chats
                </span>
              </button>
            ))}
          </div>

          <div className="mt-1.5 border-t border-line pt-1.5">
            <div className="flex items-center gap-1.5">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void create()
                  }
                }}
                placeholder="new project name…"
                aria-label="New project name"
                // `focus-outside`: the field's own border marks focus — a
                // global ring on top of it would read as a double outline
                className="focus-outside min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 py-1 text-[13px] outline-none placeholder:text-faint focus:border-lazur-dim"
              />
              <button
                type="button"
                onClick={() => void create()}
                disabled={!newName.trim() || creating}
                className="shrink-0 rounded-lg bg-lazur-dim px-2.5 py-1 text-[12px] font-semibold text-bg transition enabled:hover:brightness-110 disabled:opacity-40"
              >
                {creating ? '…' : 'Create'}
              </button>
            </div>
            {error && <div className="mt-1.5 px-1 text-[11px] text-coral">{error}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
