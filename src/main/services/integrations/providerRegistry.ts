interface Provider {
  readonly id: string
  readonly displayName: string
}

/** Keeps track of pluggable providers (text or image) by id. */
export class ProviderRegistry<P extends Provider> {
  private readonly providers = new Map<string, P>()

  register(provider: P): void {
    if (this.providers.has(provider.id)) throw new Error(`Provider "${provider.id}" is already registered`)
    this.providers.set(provider.id, provider)
  }

  get(id: string): P | undefined {
    return this.providers.get(id)
  }

  list(): P[] {
    return [...this.providers.values()]
  }

  get size(): number {
    return this.providers.size
  }
}
