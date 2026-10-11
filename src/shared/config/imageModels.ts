/**
 * What each image model accepts, taken from the official OpenAI SDK's
 * documentation of POST /images/generations (openai 7.23.0,
 * resources/images.d.ts) — not guessed. Models are matched by family so
 * dated snapshots inherit their family's rules. Anything unrecognised (e.g.
 * an OpenAI-compatible service) gets a conservative profile: one square image
 * and no optional parameters.
 */
export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface ImageModelCapabilities {
  family: string
  sizes: string[]
  /** null: the parameter isn't sent. */
  qualities: string[] | null
  /** null: output format isn't selectable (PNG is returned). */
  formats: ImageFormat[] | null
  transparentBackground: boolean
  maxPromptChars: number
  maxImages: number
  /** dall-e models need response_format=b64_json; GPT image models always return base64. */
  requestBase64: boolean
  /** The API reports token usage for this family. */
  reportsUsage: boolean
  known: boolean
}

const GPT_IMAGE: Omit<ImageModelCapabilities, 'family' | 'qualities'> = {
  sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
  formats: ['png', 'jpeg', 'webp'],
  transparentBackground: true,
  maxPromptChars: 32_000,
  maxImages: 4,
  requestBase64: false,
  reportsUsage: true,
  known: true
}

export function imageModelCapabilities(model: string | null | undefined): ImageModelCapabilities {
  const id = (model ?? '').toLowerCase()
  if (/^gpt-image-2\.5-/.test(id)) return { ...GPT_IMAGE, family: 'GPT Image 2.5', qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] }
  if (/^(gpt-image-|chatgpt-image-)/.test(id)) return { ...GPT_IMAGE, family: 'GPT Image', qualities: ['auto', 'low', 'medium', 'high'] }
  if (/^dall-e-3/.test(id)) {
    return { family: 'DALL·E 3', sizes: ['1024x1024', '1792x1024', '1024x1792'], qualities: ['standard', 'hd'], formats: null, transparentBackground: false, maxPromptChars: 4000, maxImages: 1, requestBase64: true, reportsUsage: false, known: true }
  }
  if (/^dall-e-2/.test(id)) {
    return { family: 'DALL·E 2', sizes: ['1024x1024', '512x512', '256x256'], qualities: null, formats: null, transparentBackground: false, maxPromptChars: 1000, maxImages: 4, requestBase64: true, reportsUsage: false, known: true }
  }
  return { family: 'Other model', sizes: ['1024x1024'], qualities: null, formats: null, transparentBackground: false, maxPromptChars: 4000, maxImages: 1, requestBase64: false, reportsUsage: false, known: false }
}

/** Model ids from GET /models that are image models (for the picker; any id can still be typed). */
export const isLikelyImageModel = (id: string) => /image|dall-e/i.test(id)

export const SIZE_LABEL: Record<string, string> = {
  '1024x1024': 'Square · 1024×1024',
  '1536x1024': 'Landscape · 1536×1024',
  '1024x1536': 'Portrait · 1024×1536',
  '1792x1024': 'Landscape · 1792×1024',
  '1024x1792': 'Portrait · 1024×1792',
  '512x512': 'Square · 512×512',
  '256x256': 'Square · 256×256',
  auto: 'Automatic'
}
