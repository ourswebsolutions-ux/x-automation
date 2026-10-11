/**
 * X image attachment rules, verified 2026-10-10:
 *  - Media best practices: "Image size: <= 5 MB", "Animated GIF size: <= 15 MB",
 *    supported image types JPG, PNG, GIF, WEBP, and "up to 4 photos, 1 animated
 *    GIF or 1 video in a Post".
 *    https://docs.x.com/x-api/media/quickstart/best-practices
 *  - Media metadata: alt_text maxLength 1000.
 *    https://docs.x.com/x-api/media/create-media-metadata
 */
export const X_MEDIA_LIMITS = {
  maxPhotos: 4,
  maxAnimatedGifs: 1,
  maxImageBytes: 5 * 1024 * 1024,
  maxAnimatedGifBytes: 15 * 1024 * 1024,
  maxAltTextChars: 1000,
  sources: {
    media: 'https://docs.x.com/x-api/media/quickstart/best-practices',
    altText: 'https://docs.x.com/x-api/media/create-media-metadata'
  }
} as const

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export const IMAGE_TYPES: Record<ImageMime, { label: string; extension: string }> = {
  'image/jpeg': { label: 'JPEG', extension: 'jpg' },
  'image/png': { label: 'PNG', extension: 'png' },
  'image/gif': { label: 'GIF', extension: 'gif' },
  'image/webp': { label: 'WEBP', extension: 'webp' }
}

/** Largest file the library accepts at all (the animated-GIF limit). Larger files are refused on import. */
export const LIBRARY_MAX_BYTES = X_MEDIA_LIMITS.maxAnimatedGifBytes

/** Why an image can't be attached to a post as-is, or null when it can. */
export function attachmentProblem(asset: { mimeType: ImageMime; sizeBytes: number; animated: boolean }): string | null {
  if (asset.animated) {
    return asset.sizeBytes > X_MEDIA_LIMITS.maxAnimatedGifBytes ? 'Animated GIFs can be up to 15 MB on X.' : null
  }
  if (asset.sizeBytes > X_MEDIA_LIMITS.maxImageBytes) return 'Images can be up to 5 MB on X. Generate as JPEG or WEBP, or use a smaller file.'
  return null
}

/** Problems with a whole set of attachments (count and GIF rules). */
export function attachmentSetProblem(assets: { animated: boolean }[]): string | null {
  const gifs = assets.filter((a) => a.animated).length
  if (gifs > 0 && assets.length > 1) return 'An animated GIF must be the only attachment on a post.'
  if (assets.length > X_MEDIA_LIMITS.maxPhotos) return `A post can have up to ${X_MEDIA_LIMITS.maxPhotos} images.`
  return null
}
