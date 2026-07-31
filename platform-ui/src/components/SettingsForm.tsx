// App settings form — rendered from a schema.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY A SCHEMA AND NOT AI-WRITTEN JSX. Same philosophy as `widgets`:   │
// │ a form is USER INPUT, so validation, masking and the "empty secret = │
// │ I did not change it" rule have to be enforced reliably. Handing that │
// │ logic to the AI would make it different (and sometimes broken) in    │
// │ every app.                                                           │
// │                                                                      │
// │ For complex cases the `view` route stays open (`ui.save`), but the   │
// │ ORDINARY route is this form.                                         │
// └──────────────────────────────────────────────────────────────────────┘
//
// SECRET FIELDS. They open EMPTY with an "is set" marker beside them. The
// reason: the current token lives on the server and NEVER reaches the browser
// (see the controls-layer note in `types.ts`). The user does not see the
// current value — they only write a new one.

import { useEffect, useMemo, useState } from 'react'
import type { SettingField } from '@platforma/shared'
import {
  ApiError,
  fetchAppSettings,
  saveAppSettings,
  type SettingsState,
} from '../lib/api'
import { useToast } from '../lib/toast'
import { Card } from '../ui'

/**
 * Validates a single field. Returns the message on error, otherwise `null`.
 *
 * The server runs EXACTLY the same checks again (`routes/apps.ts`) — that
 * duplication is DELIBERATE: the client side answers fast (so the user does
 * not have to press "Save" first), while the server side is the trust
 * boundary.
 */
function validateField(field: SettingField, value: string): string | null {
  const empty = value.trim().length === 0

  // Empty for a secret means "I did not change it" — NOT an error
  if (empty && field.kind === 'secret') return null

  if (empty && field.required) return 'required'

  if (empty) return null

  if (field.kind === 'number' && !Number.isFinite(Number(value))) return 'number expected'

  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(value)) {
        return field.patternHint || 'format does not match'
      }
    } catch {
      // Invalid pattern — the server side skips it too
    }
  }

  return null
}

function FieldInput({
  field,
  value,
  isSet,
  error,
  onChange,
}: {
  field: SettingField
  value: string
  isSet: boolean
  error: string | null
  onChange: (next: string) => void
}) {
  const base =
    'w-full rounded-lg border bg-bg px-3 py-2 text-sm outline-none transition-colors ' +
    (error ? 'border-gold/60 focus:border-gold' : 'border-line focus:border-lazur/60')

  if (field.kind === 'toggle') {
    // A switch — it carries its own label, so `label` is not repeated outside
    const on = value === 'true' || value === '1'
    return (
      <button
        type="button"
        onClick={() => onChange(on ? 'false' : 'true')}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          on ? 'bg-lazur' : 'bg-panel2'
        }`}
        role="switch"
        aria-checked={on}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white transition-transform ${
            on ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    )
  }

  if (field.kind === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={base}>
        <option value="">— not selected —</option>
        {(field.options ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    )
  }

  if (field.kind === 'textarea') {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className={`${base} thin-scroll resize-y font-mono text-xs`}
      />
    )
  }

  return (
    <input
      type={field.kind === 'secret' ? 'password' : 'text'}
      inputMode={field.kind === 'number' ? 'numeric' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      // For a secret field the current value is NOT SHOWN — it never reaches
      // the browser
      placeholder={
        field.kind === 'secret'
          ? isSet
            ? 'enter a new value to change it'
            : 'not set yet'
          : field.default
            ? `default: ${field.default}`
            : ''
      }
      autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
      className={base}
    />
  )
}

export default function SettingsForm({
  appId,
  onSaved,
}: {
  appId: string
  /** After saving — the caller refreshes the states */
  onSaved?: () => void
}) {
  const toast = useToast()
  const [state, setState] = useState<SettingsState | null>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Values entered by the user — kept SEPARATE from what the server sent */
  const [entered, setEntered] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setReadError(null)

    fetchAppSettings(appId)
      .then((s) => {
        if (cancelled) return
        setState(s)
        // Clear the entered values: the user may have switched apps
        setEntered({})
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setReadError(e instanceof ApiError ? e.message : 'Could not load the settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [appId])

  /** The value to display: the entered one if present, otherwise the server's */
  function valueOf(field: SettingField): string {
    if (field.key in entered) return entered[field.key]!
    // A secret NEVER comes from the server — it stays empty
    if (field.kind === 'secret') return ''
    return state?.values[field.key] ?? field.default ?? ''
  }

  const errors = useMemo(() => {
    if (!state) return {}
    const result: Record<string, string> = {}
    for (const field of state.fields) {
      // Only TOUCHED fields are validated: showing every required field in red
      // the moment the form opens would alarm the user.
      if (!(field.key in entered)) continue
      const e = validateField(field, valueOf(field))
      if (e) result[field.key] = e
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, entered])

  const changed = Object.keys(entered).length > 0
  const hasErrors = Object.keys(errors).length > 0

  async function save() {
    if (!state || !changed || hasErrors || saving) return

    // Only the CHANGED fields are sent: an untouched field keeps its value on
    // the server.
    const payload: Record<string, string> = {}
    for (const [key, value] of Object.entries(entered)) {
      const field = state.fields.find((f) => f.key === key)
      if (!field) continue
      // An empty secret means "I did not change it" — do not send it
      if (field.kind === 'secret' && value.length === 0) continue
      payload[key] = value
    }

    if (Object.keys(payload).length === 0) {
      setEntered({})
      return
    }

    setSaving(true)
    try {
      const response = await saveAppSettings(appId, payload)
      toast(response.message || 'Settings saved', 'success')
      setEntered({})

      // Re-read from the server: `read` reflects the new state and the "is
      // set" marker of the secret fields is refreshed.
      fetchAppSettings(appId)
        .then(setState)
        .catch(() => undefined)

      onSaved?.()
    } catch (e) {
      if (e instanceof ApiError) {
        // Server validation errors (400) — cases that slipped past the client
        // check (for example a stricter pattern on the server).
        toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error')
      } else {
        toast('Could not save', 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Card className="p-5">
        <div className="text-xs text-faint">Loading settings…</div>
      </Card>
    )
  }

  if (readError || !state) {
    return (
      <Card className="p-5">
        <div className="text-xs font-medium uppercase tracking-wider text-gold">Settings</div>
        <p className="mt-2 text-xs text-muted">{readError ?? 'No settings found'}</p>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="font-display text-sm font-semibold">Settings</h2>
        {state.warning && (
          // Reading failed — the form still works, and the user can fix things
          // by writing new values.
          <span className="font-mono text-[11px] text-gold" title={state.warning}>
            current values could not be read
          </span>
        )}
      </div>

      <div className="space-y-4 px-5 py-4">
        {state.fields.map((field) => {
          const error = errors[field.key]
          const isSet = state.isSet[field.key] === true

          return (
            <div key={field.key}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <label className="text-xs font-medium">
                  {field.label}
                  {field.required && <span className="ml-1 text-gold">*</span>}
                </label>

                {/* For a secret the STATE is shown, not the current value */}
                {field.kind === 'secret' && (
                  <span
                    className={`font-mono text-[11px] ${isSet ? 'text-lazur' : 'text-faint'}`}
                  >
                    {isSet ? '✓ set' : 'not set'}
                  </span>
                )}

                {error && <span className="font-mono text-[11px] text-gold">{error}</span>}
              </div>

              <FieldInput
                field={field}
                value={valueOf(field)}
                isSet={isSet}
                error={error ?? null}
                onChange={(next) => setEntered((e) => ({ ...e, [field.key]: next }))}
              />

              {field.hint && (
                <p className="mt-1 text-[11px] leading-relaxed text-faint">{field.hint}</p>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <span className="text-[11px] text-faint">
          Values are written to the app on the server
        </span>
        <div className="flex items-center gap-2">
          {changed && (
            <button
              type="button"
              onClick={() => setEntered({})}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-xs text-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!changed || hasErrors || saving}
            className="rounded-lg bg-lazur px-4 py-1.5 text-xs font-medium text-bg transition-opacity disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Card>
  )
}
