// Determines an attached file's kind from its CONTENTS.
//
// WHY WE DO NOT TRUST THE EXTENSION. The client supplies both `File.type` and
// the name itself — either can be forged. The kind is used in two places, and
// getting it wrong is expensive in both:
//
//   1) The `content-type` of the `GET /api/chat/attachment/:id` response. If a
//      file is declared as `text/html`, the browser opens it as a PAGE — that
//      is stored XSS. This is why only an image detected FROM THE CONTENTS is
//      served with its real mime type; everything else gets
//      `application/octet-stream`.
//
//   2) The note in the prompt ("attached an image" / "attached a file") and the
//      vision guard. If a ZIP named `.png` were counted as an image, a message
//      to a model without vision would fail with a pointless 400.
//
// pi does exactly the same (`pi-coding-agent/dist/utils/mime.js`): signature
// only, only the first few kilobytes. We do not inspect the whole file here
// either — a signature ends within 12 bytes at most.
//
// SVG IS DELIBERATELY ABSENT. It is XML, which makes it a vehicle for
// `<script>`, and providers do not accept it as an inline image either. An
// attached SVG comes through as an ordinary file — the agent can still read it
// as text with `read`, and the browser downloads it via `attachment` rather
// than opening it.

/** The image types both LLMs and browsers support */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Enough bytes for the signature check — nothing beyond this is read */
export const SIGNATURE_BYTES = 16

/**
 * Returns the mime type if the bytes are an image, otherwise `null`.
 *
 * `null` means "this is not an image", NOT "this file is broken": the caller
 * takes it as an ordinary file and nothing is rejected.
 */
export function imageKind(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'

  // JPEG: `FF D8 FF` plus a marker in the fourth byte. `FF D8 FF F7` is
  // JPEG-LS, which providers do not support, so it does not count as an image.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return bytes[3] === 0xf7 ? null : 'image/jpeg'
  }

  // GIF87a and GIF89a — both start with `GIF8`
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'

  // WEBP: a RIFF container, with the kind in bytes 8-11. Checking for `RIFF`
  // alone is not enough — WAV and AVI are RIFF too.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }

  return null
}

/** The file extension for an image mime type — for a paste that arrives without a name */
export function imageExtension(mime: ImageMime): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
  }
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}
