import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { IpcChannelName, IpcError, IpcResult } from '@shared/ipc/channels'
import { CredentialUnavailableError } from '../services/credentials/credentialVault'
import { DatabaseError } from '../services/database/driver'
import { ConflictError, NotFoundError, NotImplementedError, ValidationError } from '../services/errors'
import { AiServiceError } from '../services/ai/errors'
import { EngineError } from '../services/engine/engineService'
import { IxBrowserError } from '../services/integrations/ixbrowser/client'
import type { ScopedLogger } from '../services/logging/logger'
import { isTrustedRendererUrl } from '../security/trust'

type Handler<S extends z.ZodType, R> = (input: z.infer<S>, event: IpcMainInvokeEvent) => R | Promise<R>

function toIpcError(error: unknown): IpcError {
  if (error instanceof z.ZodError) {
    return { code: 'VALIDATION', message: error.issues.map((issue) => issue.message).join('; ') }
  }
  // These messages are written for users and never contain secrets.
  if (error instanceof ValidationError) return { code: 'VALIDATION', message: error.message }
  if (error instanceof NotFoundError) return { code: 'NOT_FOUND', message: error.message }
  if (error instanceof ConflictError) return { code: 'CONFLICT', message: error.message }
  if (error instanceof CredentialUnavailableError) return { code: 'UNAVAILABLE', message: error.message }
  if (error instanceof NotImplementedError) return { code: 'NOT_IMPLEMENTED', message: error.message }
  // Database details (SQL errors, constraint names) stay in the internal log.
  if (error instanceof DatabaseError) return { code: 'DATABASE', message: 'Your data could not be saved or read. Please try again.' }
  if (error instanceof EngineError) {
    // Engine messages can carry technical detail (exit codes); users get a plain sentence.
    const message = error.code === 'BUSY' ? error.message : error.code === 'ENGINE_UNAVAILABLE' ? 'Part of this installation is missing. Reinstall X Auto.' : 'The automation engine could not do that. Try again, or restart it in Settings → Automation.'
    return { code: error.code === 'ENGINE_UNAVAILABLE' ? 'UNAVAILABLE' : 'INTEGRATION', message }
  }
  if (error instanceof AiServiceError) {
    return { code: error.kind === 'not-configured' ? 'UNAVAILABLE' : 'INTEGRATION', message: error.hint ? `${error.message} — ${error.hint}` : error.message }
  }
  if (error instanceof IxBrowserError) {
    return { code: error.kind === 'not-configured' ? 'UNAVAILABLE' : 'INTEGRATION', message: error.hint ? `${error.message} — ${error.hint}` : error.message }
  }
  return { code: 'INTERNAL', message: 'Something went wrong. Please try again.' }
}

/**
 * Registers an invoke handler that:
 *  1. rejects calls from frames that are not our renderer,
 *  2. validates the payload against a schema,
 *  3. wraps the result (or error) in an IpcResult envelope.
 */
export function createIpcRouter(log: ScopedLogger) {
  return function handle<S extends z.ZodType, R>(channel: IpcChannelName, schema: S, handler: Handler<S, R>): void {
    ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<Awaited<R>>> => {
      const senderUrl = event.senderFrame?.url ?? ''
      if (!isTrustedRendererUrl(senderUrl)) {
        log.warn(`Rejected ${channel} from untrusted sender`)
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Untrusted sender.' } }
      }

      try {
        const input = schema.parse(payload)
        return { ok: true, data: await handler(input, event) }
      } catch (error) {
        const ipcError = toIpcError(error)
        if (ipcError.code === 'INTERNAL' || ipcError.code === 'DATABASE' || error instanceof EngineError) log.error(`Handler ${channel} failed`, error)
        return { ok: false, error: ipcError }
      }
    })
  }
}

export type IpcRouter = ReturnType<typeof createIpcRouter>

/** Schema for channels that take no payload. */
export const noPayload = z.undefined()
