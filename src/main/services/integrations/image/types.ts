export interface ImageGenerationRequest {
  prompt: string
  size: '1024x1024' | '1536x1024' | '1024x1536'
  count: number
}

export interface GeneratedImage {
  /** Absolute path inside the app's media folder. */
  filePath: string
  width: number
  height: number
  revisedPrompt: string | null
}

export interface ImageGenerationProvider {
  readonly id: string
  readonly displayName: string
  isConfigured(): Promise<boolean>
  generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<GeneratedImage[]>
}
