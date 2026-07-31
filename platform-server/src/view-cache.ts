// The on-disk compilation cache for `view.jsx`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS. The compiled view used to be stored in the database │
// │ alongside the manifest, so it was built exactly once — at publish    │
// │ time. Now the manifest is read from the folder on EVERY request, and │
// │ compiling JSX on every page open would be pure waste.                │
// │                                                                      │
// │ So the result is cached next to the source, keyed by a hash of that  │
// │ source. Edit `view.jsx` by hand and the hash stops matching, so the  │
// │ next read rebuilds it — no watcher, no reload button, no way for     │
// │ the cache to serve something the file no longer says.                │
// └──────────────────────────────────────────────────────────────────────┘
//
// `.build/` IS GENERATED, NEVER EDITED. It is written by the platform and can
// be deleted at any time — the next read simply rebuilds it. That is why a
// failure to WRITE the cache is not an error: the compilation itself
// succeeded, and the only cost of an unwritable cache is doing the work again.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_FILES, appFilePath } from './apps-dir.ts'
import { buildView, codeHash, type BuildResult } from './view-build.ts'

/** The compiled output */
const BUILD_JS = 'view.js'
/** The hash of the source that produced it */
const BUILD_HASH = 'view.hash'
/** The error text from the last failed build */
const BUILD_ERRORS = 'view.errors'

/**
 * Compiles `view.jsx`, reusing the cached result when the source has not
 * changed.
 *
 * FAILURES ARE CACHED TOO. Without that, a folder with a broken view would
 * re-run the whole bundler on every single request — the slowest possible
 * response for the case that is already going wrong. The error text is stored
 * next to the hash and replayed until the file changes.
 */
export async function buildViewCached(dir: string, source: string): Promise<BuildResult> {
  const buildDir = appFilePath(dir, APP_FILES.build)
  const hash = codeHash(source)

  if (buildDir && existsSync(buildDir)) {
    const cachedHash = read(join(buildDir, BUILD_HASH))

    if (cachedHash === hash) {
      const cachedErrors = read(join(buildDir, BUILD_ERRORS))
      if (cachedErrors !== null) {
        // The last build of THIS source failed — replay the reason.
        return { ok: false, errors: cachedErrors.split('\n').filter(Boolean) }
      }

      const cachedCode = read(join(buildDir, BUILD_JS))
      if (cachedCode !== null) {
        return { ok: true, code: cachedCode, hash, errors: [] }
      }
    }
  }

  const result = await buildView(source)
  writeCache(buildDir, hash, result)
  return result
}

function read(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

/**
 * Stores the build result.
 *
 * Every write is wrapped: a read-only folder or a full disk must not fail the
 * request. The cache is an optimisation — losing it costs time, not
 * correctness.
 */
function writeCache(buildDir: string | null, hash: string, result: BuildResult): void {
  if (!buildDir) return

  try {
    mkdirSync(buildDir, { recursive: true })

    if (result.ok && result.code) {
      writeFileSync(join(buildDir, BUILD_JS), result.code, 'utf8')
      // A previous failure must not linger next to a successful build.
      removeIfPresent(join(buildDir, BUILD_ERRORS))
    } else {
      writeFileSync(join(buildDir, BUILD_ERRORS), result.errors.join('\n'), 'utf8')
      removeIfPresent(join(buildDir, BUILD_JS))
    }

    // The hash is written LAST, on purpose. If the process dies midway the
    // hash is missing or stale, so the next read rebuilds — whereas writing
    // the hash first could leave it pointing at a half-written file.
    writeFileSync(join(buildDir, BUILD_HASH), hash, 'utf8')
  } catch {
    // An unwritable cache is not a failure — see the note at the top.
  }
}

/**
 * Deletes a stale cache file.
 *
 * It has to be a real DELETE, not an empty write: `read()` distinguishes
 * "missing" from "present" only by existence, so a zero-length `view.errors`
 * would be read back as "the last build of this source failed, with no
 * reason given" — and a perfectly good view would stop rendering.
 */
function removeIfPresent(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Ignored for the same reason as above.
  }
}
