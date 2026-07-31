// Skills page — connecting sources, the catalog, installing.
//
// Three layers are visible to the user as well:
//   SOURCE  — the connected GitHub repos (at the top)
//   CATALOG — the skills found in those repos (below)
//   SCOPE   — where each skill runs (globally / in selected projects)
//
// The scope is picked in the install modal. The same modal opens for an
// already-installed skill — no separate flow is needed to change the scope
// later.

import { useEffect, useMemo, useState } from 'react'
import type { Project, Skill, SkillSource } from '@platforma/shared'
import {
  ApiError,
  fetchProjects,
  deleteSkillSource,
  addSkillSource,
  syncSkillSource,
  installSkill,
  uninstallSkill,
  fetchSkills,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { Card, PageHead } from '../ui'

// ---------------------------------------------------------------------------
// Scope modal
// ---------------------------------------------------------------------------

function ScopeModal({
  skill,
  projects,
  onClose,
  onSave,
}: {
  skill: Skill
  projects: Project[]
  onClose: () => void
  onSave: (global: boolean, projectIds: string[]) => Promise<void>
}) {
  const [global, setGlobal] = useState(skill.installs.some((o) => o.scope === 'global'))
  const [selected, setSelected] = useState<Set<string>>(
    new Set(
      skill.installs.filter((o) => o.scope === 'project' && o.projectId).map((o) => o.projectId!),
    ),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nothing = !global && selected.size === 0

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(global, [...selected])
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save')
      setBusy(false)
    }
  }

  return (
    // z-60: it must open above the details modal (which is at z-50)
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${skill.name} scope`}
    >
      <Card className="rise-in w-full max-w-md p-6">
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">{skill.name}</h2>
          <p className="mt-1.5 text-sm text-muted">{skill.description}</p>

          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="mt-4 rounded-lg border border-line bg-bg p-3">
              <div className="text-xs font-medium uppercase tracking-wider text-faint">
                Tools requested by the skill
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {skill.allowedTools.map((t) => (
                  <span key={t} className="rounded-md bg-panel2 px-2 py-0.5 font-mono text-[11px] text-muted">
                    {t}
                  </span>
                ))}
              </div>
              {/* Said plainly: this list is NOT ENFORCED yet. The user must
                  not mistake it for a real restriction. */}
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                This list is informational. The actual limit is the platform's
                permission system: dangerous actions still ask for approval.
              </p>
            </div>
          )}

          <div className="mt-4 rounded-lg border border-line bg-bg p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-faint">
              Where it should work
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={global}
                onChange={(e) => setGlobal(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-ink">Everywhere (global)</span>
                <span className="block text-xs text-faint">
                  Available in all chats and projects
                </span>
              </span>
            </label>

            {projects.length > 0 && (
              <>
                <div className="mt-4 text-xs font-medium uppercase tracking-wider text-faint">
                  Or in selected projects
                </div>
                <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
                  {projects.map((l) => (
                    <label key={l.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.has(l.id)}
                        onChange={(e) => {
                          const fresh = new Set(selected)
                          if (e.target.checked) fresh.add(l.id)
                          else fresh.delete(l.id)
                          setSelected(fresh)
                        }}
                      />
                      <span className="text-muted">{l.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          <p className="mt-3 text-xs leading-relaxed text-faint">
            Skill files are copied into the working folder when the session starts.
            The agent only reads them — skill text cannot override the platform's
            security rules.
          </p>

          {error && <p className="mt-3 text-sm text-coral">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? 'Saving…' : nothing ? 'Uninstall' : 'Save'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Details modal
// ---------------------------------------------------------------------------

/**
 * The FULL information about a skill.
 *
 * On the card the description is deliberately truncated (so the cards stay the
 * same height), which is why there has to be a way to read the whole text. For
 * skills like `docx` the description runs past 900 characters.
 */
function DetailsModal({
  skill,
  sourceName,
  projectName,
  onClose,
  onScope,
}: {
  skill: Skill
  sourceName: string
  projectName: (id: string) => string
  onClose: () => void
  onScope: () => void
}) {
  const global = skill.installs.some((o) => o.scope === 'global')
  const projects = skill.installs.filter((o) => o.scope === 'project' && o.projectId)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${skill.name} details`}
    >
      {/* `Card` does not accept onClick (it is a shared component), so we wrap
          it in an outer div — clicking inside the modal must not close it */}
      <div
        className="rise-in flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">{skill.name}</h2>
            <p className="mt-0.5 font-mono text-xs text-faint">{sourceName}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-line px-2 py-1 text-sm text-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* A long description scrolls here — the modal itself does not stretch */}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{skill.description}</p>

          <dl className="mt-5 space-y-3 border-t border-line pt-4 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-faint">File</dt>
              <dd className="mt-1 break-all font-mono text-[12px] text-muted">{skill.path}</dd>
            </div>

            {skill.license && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-faint">License</dt>
                <dd className="mt-1 text-muted">{skill.license}</dd>
              </div>
            )}

            {skill.allowedTools && skill.allowedTools.length > 0 && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-faint">
                  Requested tools
                </dt>
                <dd className="mt-1.5 flex flex-wrap gap-1.5">
                  {skill.allowedTools.map((t) => (
                    <span key={t} className="rounded-md bg-panel2 px-2 py-0.5 font-mono text-[11px] text-muted">
                      {t}
                    </span>
                  ))}
                </dd>
              </div>
            )}

            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-faint">Scope</dt>
              <dd className="mt-1 text-muted">
                {global && <div className="text-mint">✓ Global — everywhere</div>}
                {projects.map((o) => (
                  <div key={o.projectId} className="text-mint">
                    ✓ {projectName(o.projectId!)}
                  </div>
                ))}
                {!global && projects.length === 0 && <span className="text-faint">not installed</span>}
              </dd>
            </div>

            {skill.warnings.length > 0 && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-gold">
                  Warnings
                </dt>
                <dd className="mt-1.5">
                  <ul className="space-y-1 text-[13px] text-muted">
                    {skill.warnings.map((o, i) => (
                      <li key={i}>• {o}</li>
                    ))}
                  </ul>
                  {/* A warning does not stop the skill from working — we say
                      so plainly, otherwise the user reads it as an error */}
                  <p className="mt-2 text-[11px] leading-relaxed text-faint">
                    These are mismatches with the spec. The skill still works.
                  </p>
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="mt-5 flex shrink-0 justify-end gap-2 border-t border-line pt-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
          >
            Close
          </button>
          <button
            onClick={onScope}
            className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110"
          >
            {global || projects.length > 0 ? 'Change scope' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sources section
// ---------------------------------------------------------------------------

function Sources({
  sources,
  onRefreshed,
}: {
  sources: SkillSource[]
  onRefreshed: () => void
}) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const toast = useToast()

  const add = async () => {
    if (!url.trim() || busy) return
    setBusy(true)
    try {
      const result = await addSkillSource(url.trim())
      setUrl('')
      const warnCount = result.warnings.length
      toast(
        `${result.source.owner}/${result.source.repo}: ${result.added} skills found` +
          (warnCount > 0 ? ` · ${warnCount} warnings` : ''),
        // Gold when there are warnings: the skills were added anyway, but the
        // user should look them over
        warnCount > 0 ? 'warning' : 'success',
      )
      onRefreshed()
    } catch (e) {
      toast(
        e instanceof ApiError
          ? [e.message, e.detail].filter(Boolean).join(' — ')
          : 'Could not connect',
        'error',
      )
    } finally {
      setBusy(false)
    }
  }

  const sync = async (id: string) => {
    setBusyId(id)
    try {
      const n = await syncSkillSource(id)
      toast(
        `Synced: +${n.added} new, ${n.updated} updated, -${n.deleted}`,
        'success',
      )
      onRefreshed()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not sync', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (m: SkillSource) => {
    if (!confirm(`Delete the source ${m.owner}/${m.repo} and all of its skills?`)) return
    setBusyId(m.id)
    try {
      await deleteSkillSource(m.id)
      toast(`${m.owner}/${m.repo} deleted`, 'success')
      onRefreshed()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not delete', 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card className="mb-6 p-5">
      <h2 className="font-display text-[15px] font-semibold">Sources</h2>
      <p className="mt-1 text-sm text-muted">
        Connect a GitHub repo — every <code className="font-mono text-xs">SKILL.md</code> file inside
        lands in the catalog. There is no registry; any repo works.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="anthropics/skills or https://github.com/..."
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
        />
        <button
          onClick={add}
          disabled={busy || !url.trim()}
          className="rounded-lg bg-lazur-dim px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Scanning…' : 'Connect'}
        </button>
      </div>

      {sources.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          {sources.map((m) => {
            // The builtin source ships with the platform and is recreated on
            // every start — deleting or syncing it would be meaningless (the
            // button would click, nothing would change).
            const isBuiltin = m.kind === 'builtin'
            return (
              <div key={m.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-[13px] text-ink">
                    {isBuiltin ? 'platform' : `${m.owner}/${m.repo}`}
                  </span>
                  <span className="ml-2 text-xs text-faint">
                    {isBuiltin ? 'built-in skills' : m.ref}
                    {!isBuiltin &&
                      m.lastSync &&
                      ` · ${new Date(m.lastSync).toLocaleDateString('en-US')}`}
                  </span>
                </div>
                {!isBuiltin && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => sync(m.id)}
                      disabled={busyId === m.id}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink disabled:opacity-50"
                    >
                      {busyId === m.id ? '…' : 'Sync'}
                    </button>
                    <button
                      onClick={() => remove(m)}
                      disabled={busyId === m.id}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition hover:text-coral disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Skills() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [sources, setSources] = useState<SkillSource[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<Skill | null>(null)
  const [details, setDetails] = useState<Skill | null>(null)

  // Search and filters. Connect a few repos and the catalog reaches hundreds
  // of skills — scanning the list by eye becomes impossible.
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'installed' | 'not-installed'>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')

  /** It also RETURNS the new list — so the caller can refresh an open modal */
  const load = async (): Promise<Skill[] | null> => {
    try {
      const [catalog, projectList] = await Promise.all([fetchSkills(), fetchProjects()])
      setSkills(catalog.skills)
      setSources(catalog.sources)
      setProjects(projectList)
      setError(null)
      return catalog.skills
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the data')
      return null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /**
   * Saves the scope: the new state is compared with the old one and only the
   * DIFFERENCE is sent. Rewriting everything would work too, but it would
   * force the file to be re-downloaded on every save.
   */
  const saveScope = async (skill: Skill, global: boolean, projectIds: string[]) => {
    const wasGlobal = skill.installs.some((o) => o.scope === 'global')
    const oldProjects = new Set(
      skill.installs.filter((o) => o.scope === 'project' && o.projectId).map((o) => o.projectId!),
    )
    const newProjects = new Set(projectIds)

    const toAdd = projectIds.filter((id) => !oldProjects.has(id))
    const toRemove = [...oldProjects].filter((id) => !newProjects.has(id))

    if (global && !wasGlobal) await installSkill(skill.id, 'global')
    if (toAdd.length > 0) await installSkill(skill.id, 'project', toAdd)
    if (!global && wasGlobal) await uninstallSkill(skill.id, 'global')
    if (toRemove.length > 0) await uninstallSkill(skill.id, 'project', toRemove)

    const fresh = await load()

    // If the details modal is open we bind it to the NEW object — otherwise
    // it would keep showing the old `installs` list
    setDetails((previous) =>
      previous ? (fresh?.find((s) => s.id === previous.id) ?? previous) : null,
    )
  }

  const scopeText = (skill: Skill): string => {
    const global = skill.installs.some((o) => o.scope === 'global')
    const projectCount = skill.installs.filter((o) => o.scope === 'project').length
    if (global && projectCount > 0) return `Global + ${projectCount} projects`
    if (global) return 'Global'
    if (projectCount > 0) return `${projectCount} projects`
    return ''
  }

  const sourceName = (sourceId: string): string => {
    const m = sources.find((x) => x.id === sourceId)
    return m ? `${m.owner}/${m.repo}` : ''
  }

  const projectName = (id: string): string => projects.find((l) => l.id === id)?.name ?? id

  /**
   * Search + filters.
   *
   * The search covers NAME and DESCRIPTION: users usually remember what a
   * skill does rather than what it is called ("word", "pdf", "presentation"),
   * so searching by name alone is not enough.
   *
   * The words are checked SEPARATELY (`AND`): typing "word doc" finds a skill
   * containing both words, in any order.
   */
  const visible = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)

    return skills.filter((s) => {
      if (statusFilter === 'installed' && s.installs.length === 0) return false
      if (statusFilter === 'not-installed' && s.installs.length > 0) return false
      if (sourceFilter !== 'all' && s.sourceId !== sourceFilter) return false

      if (words.length === 0) return true
      const text = `${s.name} ${s.description}`.toLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [skills, search, statusFilter, sourceFilter])

  const hasFilter = search.trim() !== '' || statusFilter !== 'all' || sourceFilter !== 'all'

  const clearFilters = () => {
    setSearch('')
    setStatusFilter('all')
    setSourceFilter('all')
  }

  const installedCount = skills.filter((s) => s.installs.length > 0).length

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHead
        title="Skills"
        sub="SKILL.md packages: connected from GitHub, running globally or in selected projects"
      />

      <Sources sources={sources} onRefreshed={load} />

      {error && (
        <Card className="mb-6 border-coral/40 p-4">
          <p className="text-sm text-coral">{error}</p>
        </Card>
      )}

      {/* Search panel — shown when the catalog is not empty */}
      {!loading && skills.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-55 flex-1">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search: name or task (word, pdf, deploy…)"
              aria-label="Search skills"
              className="w-full rounded-lg border border-line bg-bg py-2 pl-9 pr-8 text-sm outline-none placeholder:text-faint focus:border-lazur-dim"
            />
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-faint" aria-hidden>
              ⌕
            </span>
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-faint transition hover:text-ink"
              >
                ✕
              </button>
            )}
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            aria-label="Filter by status"
            className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted outline-none focus:border-lazur-dim"
          >
            <option value="all">All ({skills.length})</option>
            <option value="installed">Installed ({installedCount})</option>
            <option value="not-installed">Not installed ({skills.length - installedCount})</option>
          </select>

          {/* The source filter only makes sense with several repos connected */}
          {sources.length > 1 && (
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              aria-label="Filter by source"
              className="max-w-50 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted outline-none focus:border-lazur-dim"
            >
              <option value="all">All sources</option>
              {sources.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.kind === 'builtin' ? 'platform (built-in)' : `${m.owner}/${m.repo}`}
                </option>
              ))}
            </select>
          )}

          {hasFilter && (
            <>
              <span className="text-sm text-faint">
                {visible.length} / {skills.length}
              </span>
              <button
                onClick={clearFilters}
                className="rounded-lg border border-line px-3 py-2 text-sm text-muted transition hover:text-ink"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : skills.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            The catalog is empty. Connect a GitHub repo above — for example{' '}
            <code className="font-mono text-xs text-ink">anthropics/skills</code>.
          </p>
        </Card>
      ) : visible.length === 0 ? (
        // The filter found nothing — a DIFFERENT case from an empty catalog,
        // so the message differs too
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">Nothing found.</p>
          <button
            onClick={clearFilters}
            className="mt-3 text-sm text-lazur transition hover:brightness-125"
          >
            Clear filters
          </button>
        </Card>
      ) : (
        // NO `items-start`: the grid cells stretch so cards in a row stay the
        // same height. The description is clamped to 4 lines (`line-clamp-4`)
        // — so `docx`'s 900-character text does not stretch the whole row.
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => {
            const scope = scopeText(s)
            return (
              <Card key={s.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-display text-[15px] font-semibold">{s.name}</h2>
                  {s.warnings.length > 0 && (
                    <span
                      className="shrink-0 rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-gold"
                      title={s.warnings.join('\n')}
                    >
                      {s.warnings.length} warn.
                    </span>
                  )}
                </div>

                {/* `flex-1` eats the free space — so the bottom row sits at
                    the same height on every card */}
                <div className="mt-2 flex-1">
                  <p className="line-clamp-4 text-sm leading-relaxed text-muted">{s.description}</p>
                  <button
                    onClick={() => setDetails(s)}
                    className="mt-1.5 text-xs text-lazur transition hover:brightness-125"
                  >
                    Details →
                  </button>
                </div>

                <div className="mt-3 font-mono text-[11px] text-faint">{sourceName(s.sourceId)}</div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                  {scope ? (
                    <span className="truncate text-sm text-mint" title={scope}>
                      ✓ {scope}
                    </span>
                  ) : (
                    <span className="text-xs text-faint">not installed</span>
                  )}
                  <button
                    onClick={() => setModal(s)}
                    className={
                      scope
                        ? 'shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:text-ink'
                        : 'shrink-0 rounded-lg border border-lazur-dim px-3 py-1.5 text-sm text-lazur transition hover:bg-lazur-dim hover:text-bg'
                    }
                  >
                    {scope ? 'Change' : 'Install'}
                  </button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* It sits under the details modal: pressing "Install" there opens the
          scope modal on top, and closing it reveals the details again */}
      {details && (
        <DetailsModal
          skill={details}
          sourceName={sourceName(details.sourceId)}
          projectName={projectName}
          onClose={() => setDetails(null)}
          onScope={() => setModal(details)}
        />
      )}

      {modal && (
        <ScopeModal
          skill={modal}
          projects={projects}
          onClose={() => setModal(null)}
          onSave={(global, ids) => saveScope(modal, global, ids)}
        />
      )}
    </div>
  )
}
