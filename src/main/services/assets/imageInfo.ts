import type { ImageMime } from '@shared/config/mediaLimits'

export interface ImageInfo {
  mimeType: ImageMime
  width: number
  height: number
  animated: boolean
}

/**
 * Identifies an image by its bytes (never by file name) and reads its
 * dimensions from the header. Returns a reason string when the file is not a
 * supported image or looks truncated/corrupted. Nothing here decodes pixels or
 * runs anything from the file.
 */
export function inspectImage(bytes: Buffer): ImageInfo | string {
  if (bytes.length < 16) return 'The file is empty or too small to be an image.'
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return png(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes)
  const head = bytes.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') return gif(bytes)
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return webp(bytes)
  return 'Not a supported image. Use JPEG, PNG, GIF or WEBP.'
}

const sane = (w: number, h: number) => w > 0 && h > 0 && w <= 20_000 && h <= 20_000

function png(b: Buffer): ImageInfo | string {
  if (b.subarray(12, 16).toString('latin1') !== 'IHDR' || b.length < 33) return 'This PNG file is damaged (no header).'
  const width = b.readUInt32BE(16)
  const height = b.readUInt32BE(20)
  if (!sane(width, height)) return 'This PNG has invalid dimensions.'
  if (b.subarray(b.length - 12).indexOf(Buffer.from('IEND', 'latin1')) < 0) return 'This PNG file is incomplete or damaged.'
  // APNG (animated PNG) is not an X-supported animation format; treat it as a still image but note it via acTL presence.
  return { mimeType: 'image/png', width, height, animated: false }
}

function jpeg(b: Buffer): ImageInfo | string {
  let offset = 2
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return 'This JPEG file is damaged.'
    const marker = b[offset + 1]!
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = b.readUInt16BE(offset + 2)
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = b.readUInt16BE(offset + 5)
      const width = b.readUInt16BE(offset + 7)
      if (!sane(width, height)) return 'This JPEG has invalid dimensions.'
      const tail = b.subarray(Math.max(0, b.length - 4096))
      if (tail.lastIndexOf(Buffer.from([0xff, 0xd9])) < 0) return 'This JPEG file is incomplete or damaged.'
      return { mimeType: 'image/jpeg', width, height, animated: false }
    }
    offset += 2 + length
  }
  return 'This JPEG file is damaged (no frame header).'
}

function gif(b: Buffer): ImageInfo | string {
  const width = b.readUInt16LE(6)
  const height = b.readUInt16LE(8)
  if (!sane(width, height)) return 'This GIF has invalid dimensions.'
  if (b[b.length - 1] !== 0x3b) return 'This GIF file is incomplete or damaged.'
  // More than one image descriptor preceded by a graphic control block = animation.
  let frames = 0
  let from = 13
  for (;;) {
    const i = b.indexOf(Buffer.from([0x21, 0xf9, 0x04]), from)
    if (i < 0) break
    frames++
    if (frames > 1) break
    from = i + 3
  }
  return { mimeType: 'image/gif', width, height, animated: frames > 1 }
}

function webp(b: Buffer): ImageInfo | string {
  const riffSize = b.readUInt32LE(4)
  if (riffSize + 8 > b.length + 1) return 'This WEBP file is incomplete or damaged.'
  const chunk = b.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8 ' && b.length >= 30) {
    const width = b.readUInt16LE(26) & 0x3fff
    const height = b.readUInt16LE(28) & 0x3fff
    return sane(width, height) ? { mimeType: 'image/webp', width, height, animated: false } : 'This WEBP has invalid dimensions.'
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return 'This WEBP file is damaged.'
    const bits = b.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return sane(width, height) ? { mimeType: 'image/webp', width, height, animated: false } : 'This WEBP has invalid dimensions.'
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    const animated = (b[20]! & 0x02) !== 0
    const width = 1 + b.readUIntLE(24, 3)
    const height = 1 + b.readUIntLE(27, 3)
    if (animated) return 'Animated WEBP is not supported on X — use an animated GIF instead.'
    return sane(width, height) ? { mimeType: 'image/webp', width, height, animated: false } : 'This WEBP has invalid dimensions.'
  }
  return 'This WEBP file is damaged or uses an unknown encoding.'
}
