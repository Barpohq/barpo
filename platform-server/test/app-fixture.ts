// Test helper: building an app FOLDER on disk.
//
// An app is no longer a row that can be inserted with one call — it is a
// directory of files. Every test that needs a published app would otherwise
// repeat the same mkdir/writeFile/publish dance, so it lives here once.
//
// `PLATFORM_APPS` points the storage root at a temporary directory, exactly as
// `PLATFORM_WORKS` and `PLATFORM_PROJECTS` do elsewhere in the suite.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AppManifest } from '@barpo/shared'
import { publishDashboard } from '../src/dashboard-save.ts'

/**
 * What the fixtures accept.
 *
 * A real `AppManifest` OR a loose object: tests need to describe both valid
 * apps and deliberately broken ones, and an interface alone cannot express
 * the second.
 */
export type ManifestLike = AppManifest | Record<string, unknown>

/**
 * Points the apps root at a fresh temporary directory.
 *
 * Call in `beforeEach`, and pass the result to `cleanupApps` in `afterEach`.
 */
export function useTempApps(): string {
  const root = mkdtempSync(join(tmpdir(), 'barpo-apps-'))
  process.env.PLATFORM_APPS = root
  return root
}

export function cleanupApps(root: string): void {
  rmSync(root, { recursive: true, force: true })
  delete process.env.PLATFORM_APPS
}

/** Writes one file inside an app folder, creating the directories it needs */
export function writeAppFile(root: string, id: string, file: string, content: string): void {
  const path = join(root, id, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/**
 * Writes `app.json` for an app.
 *
 * `id` is filled in automatically — it has to match the folder name, and
 * getting that wrong in a fixture would fail tests for the wrong reason.
 */
export function writeManifest(
  root: string,
  id: string,
  manifest: Record<string, unknown> = {},
): void {
  writeAppFile(
    root,
    id,
    'app.json',
    JSON.stringify({
      id,
      name: id,
      widgets: [{ type: 'note', text: 'hello' }],
      ...manifest,
    }),
  )
}

/**
 * Writes a WHOLE manifest out as a folder — code split into its own files.
 *
 * This is the bridge for tests that were written against the old blob model:
 * they can keep describing an app as one object, and this function puts each
 * piece where the folder model expects it. New tests are better off writing
 * the files directly, the way the agent does.
 */
export function writeManifestAsFolder(
  root: string,
  input: ManifestLike,
): void {
  // Widened once, here: `AppManifest` is an interface, so it has no index
  // signature and every field access below would need its own cast.
  const manifest = input as Record<string, unknown>
  const id = String(manifest.id)
  const config: Record<string, unknown> = { ...manifest }

  // `states` becomes one file per state, plus an interval map in app.json.
  if (Array.isArray(manifest.states)) {
    const stateConfig: Record<string, unknown> = {}
    for (const state of manifest.states as Record<string, unknown>[]) {
      const name = String(state.name)
      writeAppFile(root, id, join('states', `${name}.js`), String(state.code ?? ''))
      stateConfig[name] = state.interval !== undefined ? { interval: state.interval } : {}
    }
    config.states = stateConfig
  }

  // `actions` becomes one file per action, plus a label map in app.json.
  if (Array.isArray(manifest.actions)) {
    const actionConfig: Record<string, unknown> = {}
    for (const action of manifest.actions as Record<string, unknown>[]) {
      const name = String(action.name)
      writeAppFile(root, id, join('actions', `${name}.js`), String(action.code ?? ''))
      const { name: _n, code: _c, ...meta } = action
      actionConfig[name] = meta
    }
    config.actions = actionConfig
  }

  // `settings` keeps its field schema in app.json; the code moves to its files.
  if (manifest.settings && typeof manifest.settings === 'object') {
    const settings = manifest.settings as Record<string, unknown>
    if (settings.write) writeAppFile(root, id, 'settings.js', String(settings.write))
    if (settings.read) writeAppFile(root, id, 'settings.read.js', String(settings.read))
    const { write: _w, read: _r, ...rest } = settings
    config.settings = rest
  }

  // `view` moves to view.jsx — as SOURCE, since the platform compiles it.
  if (manifest.view && typeof manifest.view === 'object') {
    const view = manifest.view as Record<string, unknown>
    if (view.code) writeAppFile(root, id, 'view.jsx', String(view.code))
    delete config.view
  }

  writeAppFile(root, id, 'app.json', JSON.stringify(config))
}

/**
 * Writes an app folder and publishes it — the shortest path from "no app" to
 * "an app the API will serve".
 */
export async function publishTestApp(
  root: string,
  id: string,
  manifest: Record<string, unknown> = {},
  database?: Database,
): Promise<void> {
  writeManifest(root, id, manifest)
  await publishOrThrow(id, database)
}

/** The same, for a full manifest object split across files */
export async function publishManifest(
  root: string,
  manifest: ManifestLike,
  database?: Database,
): Promise<void> {
  writeManifestAsFolder(root, manifest)
  await publishOrThrow(String((manifest as Record<string, unknown>).id), database)
}

async function publishOrThrow(id: string, database?: Database): Promise<void> {
  const result = await publishDashboard(id, database)
  if (!result.ok) {
    // Failing loudly here saves a confusing "app not found" three assertions
    // later in whichever test called this.
    throw new Error(`Test app "${id}" failed to publish: ${result.errors?.join('; ')}`)
  }
}
