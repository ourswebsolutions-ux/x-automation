/** Thrown by service boundaries whose implementation lands in a later phase. */
export class NotImplementedError extends Error {
  constructor(
    readonly feature: string,
    readonly phase: number
  ) {
    super(`${feature} is not available yet (planned for Phase ${phase}).`)
    this.name = 'NotImplementedError'
  }
}

/** Input was understood but rejected. The message is safe to show the user. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}
