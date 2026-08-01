// Minimal tar reader — used to extract a skill directory from a GitHub tarball.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY NOT THE EXTERNAL `tar`: zip-slip. If a path inside the archive   │
// │ is `../../../.ssh/authorized_keys`, `tar -x` writes it OUTSIDE the   │
// │ target directory. The archive comes from a stranger's GitHub repo,   │
// │ so this is not a theoretical risk.                                   │
// │                                                                      │
// │ GNU tar has `--strip-components`, but the protective flags differ    │
// │ from platform to platform (bsdtar and GNU tar are not the same), and │
// │ parsing subprocess output is unreliable. The format itself is very   │
// │ simple — a 512-byte header block plus data — so we do the reading    │
// │ ourselves and check EVERY path ourselves.                            │
// └──────────────────────────────────────────────────────────────────────┘
//
// Supported: regular files (`0`), directories (`5`), GNU long names (`L`),
// PAX extensions (`x`/`g` — skipped). Symlinks (`1`, `2`) are DELIBERATELY
// DROPPED: a symlink inside a skill directory would be a way out of the
// sandbox boundary (`environment.ts` catches it with canonicalPath, but not
// writing it here at all is better still).

const BLOCK = 512

export interface TarFile {
  /** The sanitised path inside the archive — no `..` and no absolute paths */
  path: string
  contents: Uint8Array
}

/** An octal numeric field (it may end with a NUL or a space) */
function octal(bytes: Uint8Array): number {
  let text = ''
  for (const b of bytes) {
    if (b === 0 || b === 0x20) break
    text += String.fromCharCode(b)
  }
  const n = parseInt(text, 8)
  return Number.isFinite(n) ? n : 0
}

function textField(bytes: Uint8Array): string {
  let end = bytes.indexOf(0)
  if (end === -1) end = bytes.length
  return new TextDecoder().decode(bytes.subarray(0, end))
}

/**
 * Brings a path into a safe form.
 *
 * A `null` return means the path is DANGEROUS and the file must be dropped
 * entirely: an absolute path, a `..` segment, or a Windows drive prefix.
 */
export function sanitisePath(raw: string): string | null {
  // A backslash also counts as a separator, so that `..\..\x` is not let
  // through
  const normalised = raw.replace(/\\/g, '/')

  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return null

  const parts: string[] = []
  for (const p of normalised.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') return null
    // NUL and control characters have no business in a file name
    if (/[\0]/.test(p)) return null
    parts.push(p)
  }

  return parts.length > 0 ? parts.join('/') : null
}

/**
 * Reads a tar archive. Entries with a dangerous path are DROPPED SILENTLY
 * (not treated as an error): we do not lose a whole skill over one bad entry.
 *
 * `maxTotalBytes` — the limit on extracted data (zip-bomb protection). Going
 * over it throws — at that point the archive is not a normal one anyway.
 */
export function readTar(raw: Uint8Array, maxTotalBytes: number): TarFile[] {
  const result: TarFile[] = []
  let total = 0
  let offset = 0
  // A GNU `L` entry supplies the long name for the next file
  let pendingName: string | null = null

  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK)

    // Two consecutive empty blocks — the end of the archive
    if (header.every((b) => b === 0)) break

    const name = textField(header.subarray(0, 100))
    const size = octal(header.subarray(124, 136))
    const kind = String.fromCharCode(header[156] ?? 0)
    // The `prefix` field (USTAR): long paths are split here
    const prefix = textField(header.subarray(345, 500))

    offset += BLOCK
    const data = raw.subarray(offset, offset + size)
    // The data is padded out to 512
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (kind === 'L') {
      // GNU long name — it belongs to the next entry
      pendingName = textField(data)
      continue
    }
    if (kind === 'x' || kind === 'g') continue // PAX metadata
    if (kind !== '0' && kind !== '\0') continue // regular files only

    const fullName = pendingName ?? (prefix ? `${prefix}/${name}` : name)
    pendingName = null

    const safePath = sanitisePath(fullName)
    if (!safePath) continue

    total += size
    if (total > maxTotalBytes) {
      throw new Error(`Archive too large: exceeded the ${maxTotalBytes} byte limit`)
    }

    result.push({ path: safePath, contents: new Uint8Array(data) })
  }

  return result
}
