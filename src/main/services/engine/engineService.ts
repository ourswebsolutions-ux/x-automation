import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { EngineLogLine, EngineState, EngineStatus } from '@shared/types/engine'
import { redact } from '../logging/logger'
import type { ScopedLogger } from '../logging/logger'

export interface EnginePaths {
  /** Folder holding run.py and axora_engine/. */
  engineDir: string
  /** The bundled interpreter (python.exe on Windows, bin/python3 elsewhere). */
  pythonExe: string
  /** Where the engine may write debugging screenshots. */
  diagnosticsDir: string
}

interface Deps {
  paths: EnginePaths
  log: ScopedLogger
  onChange: () => void
  /** Development/test only: lets x.publish target a loopback test page instead of x.com. */
  allowTestTargets?: boolean
}

export interface RequestOptions {
  timeoutMs?: number
  /** Called with each progress stage the engine reports for this request. */
  onProgress?: (stage: string) => void
}

/** A failure reported by (or about) the engine. Messages are written for users. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    /** Set by commands with side effects: true = the action may already have taken effect. */
    readonly submitted: boolean | null = null
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

const HANDSHAKE_MS = 20_000
const HEALTH_EVERY_MS = 30_000
const IDLE_STOP_MS = 15 * 60_000
const SHUTDOWN_GRACE_MS = 2_000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 5 * 60_000
const MAX_LINE = 1024 * 1024
const LOG_LINES = 200

/** Only these commands are ever sent — the engine enforces the same list. */
export type EngineCommand = 'engine.hello' | 'engine.health' | 'engine.shutdown' | 'browser.check' | 'browser.selfTest' | 'x.publish' | 'x.openPost' | 'x.findPost' | 'x.repost'

const responseSchema = z.union([
  z.object({ id: z.string().nullable(), ok: z.literal(true), result: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({
      id: z.string().nullable(),
      ok: z.literal(false),
      error: z.object({ code: z.string().max(40), message: z.string().max(500), retryable: z.boolean(), submitted: z.boolean().optional() }).strict()
    })
    .strict(),
  z.object({ event: z.literal('log'), level: z.string().max(10), message: z.string().max(600) }).strict(),
  z.object({ event: z.literal('progress'), id: z.string().max(64), stage: z.string().max(40) }).strict(),
  z.object({ event: z.literal('ready'), pid: z.number() }).strict()
])

const helloSchema = z
  .object({ engine: z.string(), protocol: z.number(), python: z.string(), playwright: z.string().nullable(), platform: z.string(), executable: z.string() })
  .passthrough()

/** A small environment for the child — nothing inherited that could hold secrets. */
function childEnv(allowTestTargets: boolean): NodeJS.ProcessEnv {
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
  const test = allowTestTargets ? { AXORA_ENGINE_TEST_TARGETS: '1' } : {}
  if (process.platform === 'win32') {
    return {
      ...pick(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'COMPUTERNAME']),
      PATH: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
      ...test
    }
  }
  return { ...pick(['HOME', 'TMPDIR', 'LANG', 'LC_ALL']), PATH: '/usr/bin:/bin', ...test }
}

/**
 * Supervises the Python automation engine. It is started on demand, spoken to
 * over its stdin/stdout (no network port), health-checked, stopped when idle,
 * restarted after a crash a bounded number of times, and shut down with the app.
 */
export class EngineService {
  private child: ChildProcessWithoutNullStreams | null = null
  private state: EngineState = 'stopped'
  private starting: Promise<void> | null = null
  private readonly pending = new Map<
    string,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; cmd: string; onProgress?: (stage: string) => void }
  >()
  private buffer = ''
  private versions: z.infer<typeof helloSchema> | null = null
  private startedAt: number | null = null
  private lastActivity = Date.now()
  private restarts: number[] = []
  private lastError: string | null = null
  private readonly logs: EngineLogLine[] = []
  private healthTimer: NodeJS.Timeout | null = null
  private stopping = false
  private healthFailures = 0

  constructor(private readonly deps: Deps) {}

  get diagnosticsDir(): string {
    return this.deps.paths.diagnosticsDir
  }

  status(): EngineStatus {
    const runtime = { python: this.deps.paths.pythonExe, pythonFound: existsSync(this.deps.paths.pythonExe), engineFound: existsSync(`${this.deps.paths.engineDir}/run.py`) }
    return {
      state: !runtime.pythonFound || !runtime.engineFound ? 'unavailable' : this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      versions: this.versions ? { engine: this.versions.engine, python: this.versions.python, playwright: this.versions.playwright, platform: this.versions.platform } : null,
      restartsRecent: this.restarts.filter((t) => Date.now() - t < RESTART_WINDOW_MS).length,
      lastError: this.lastError,
      runtime,
      logs: [...this.logs]
    }
  }

  /** Sends one allowlisted command, starting the engine first if needed. */
  async request<T extends Record<string, unknown>>(cmd: EngineCommand, params: Record<string, unknown> = {}, options: number | RequestOptions = 30_000): Promise<T> {
    const { timeoutMs = 30_000, onProgress } = typeof options === 'number' ? { timeoutMs: options } : options
    await this.ensureStarted()
    return this.send<T>(cmd, params, timeoutMs, onProgress)
  }

  /** True while any request is waiting for the engine. */
  get busy(): boolean {
    return this.pending.size > 0
  }

  async ensureStarted(): Promise<void> {
    if (this.state === 'ready' && this.child) return
    if (this.starting) return this.starting
    const status = this.status()
    if (status.state === 'unavailable') {
      throw new EngineError(
        'ENGINE_UNAVAILABLE',
        status.runtime.pythonFound ? 'The automation engine files are missing from this installation.' : 'The bundled Python runtime is missing from this installation.',
        false
      )
    }
    if (this.state === 'failed') throw new EngineError('ENGINE_FAILED', 'The automation engine stopped repeatedly. Restart it from Settings → Automation engine after checking the log.')
    this.starting = this.start().finally(() => (this.starting = null))
    return this.starting
  }

  /** Manual restart from the UI — also clears the "failed" state. */
  async restart(): Promise<EngineStatus> {
    await this.stop('restart')
    this.restarts = []
    this.state = 'stopped'
    this.lastError = null
    await this.ensureStarted()
    return this.status()
  }

  async stop(reason: string): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    this.setState('stopping')
    try {
      await this.send('engine.shutdown', {}, SHUTDOWN_GRACE_MS).catch(() => undefined)
      // Wait for 'close' (as onExit does), so the state is settled when stop() returns.
      await new Promise<void>((resolve) => {
        if (this.child !== child) return resolve()
        const timer = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
        const giveUp = setTimeout(resolve, SHUTDOWN_GRACE_MS * 3)
        child.once('close', () => (clearTimeout(timer), clearTimeout(giveUp), resolve()))
      })
    } finally {
      this.stopping = false
      this.deps.log.info(`Automation engine stopped (${reason})`)
    }
  }

  /** Last-resort synchronous cleanup when the app quits. */
  killNow(): void {
    if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL')
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    const recent = this.restarts.filter((t) => Date.now() - t < RESTART_WINDOW_MS)
    if (this.state === 'crashed' && recent.length >= MAX_RESTARTS) {
      this.setState('failed')
      throw new EngineError('ENGINE_FAILED', 'The automation engine crashed repeatedly and was not restarted. Check the engine log in Settings → Automation engine.')
    }
    if (this.state === 'crashed') this.restarts.push(Date.now())
    this.setState('starting')
    const { pythonExe, engineDir } = this.deps.paths
    const child = spawn(pythonExe, ['-I', '-X', 'utf8', '-u', 'run.py'], { cwd: engineDir, env: childEnv(this.deps.allowTestTargets === true), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.buffer = ''
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new EngineError('ENGINE_START_TIMEOUT', 'The automation engine did not start in time.', true)), HANDSHAKE_MS)
      this.onReady = () => (clearTimeout(timer), resolve())
      child.once('error', (error) => (clearTimeout(timer), reject(new EngineError('ENGINE_START_FAILED', `The automation engine could not be started: ${error.message}`, true))))
      child.once('exit', (code) => (clearTimeout(timer), reject(new EngineError('ENGINE_START_FAILED', `The automation engine exited during start-up (code ${code}).`, true))))
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) this.addLog('stderr', line)
    })
    // 'close' (not 'exit'): fires only after stdout has been fully read, so a
    // progress event written just before a crash is never lost.
    child.on('close', (code, signal) => this.onExit(child, code, signal))
    try {
      await ready
      const hello = helloSchema.parse(await this.send('engine.hello', {}, HANDSHAKE_MS))
      this.versions = hello
      this.startedAt = Date.now()
      this.lastActivity = Date.now()
      this.lastError = null
      this.setState('ready')
      this.startHealth()
      this.deps.log.success(`Automation engine ready (Python ${hello.python}, Playwright ${hello.playwright ?? 'missing'})`, { pid: child.pid ?? null })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Start-up failed'
      this.deps.log.error('Automation engine failed to start', error)
      if (child.exitCode === null) child.kill('SIGKILL')
      this.child = null
      this.setState('crashed')
      throw error instanceof EngineError ? error : new EngineError('ENGINE_START_FAILED', 'The automation engine could not be started.', true)
    }
  }

  private onReady: (() => void) | null = null

  private send<T extends Record<string, unknown>>(cmd: EngineCommand, params: Record<string, unknown>, timeoutMs: number, onProgress?: (stage: string) => void): Promise<T> {
    const child = this.child
    if (!child || child.exitCode !== null) return Promise.reject(new EngineError('ENGINE_NOT_RUNNING', 'The automation engine is not running.', true))
    const id = randomUUID()
    this.lastActivity = Date.now()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new EngineError('ENGINE_TIMEOUT', `The automation engine did not answer “${cmd}” in time.`, true))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject, timer, cmd, onProgress })
      child.stdin.write(`${JSON.stringify({ id, cmd, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new EngineError('ENGINE_NOT_RUNNING', 'The automation engine stopped accepting commands.', true))
      })
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE * 2) {
      this.addLog('engine', 'Discarded an oversized message from the engine.')
      this.buffer = ''
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onMessage(line)
    }
  }

  private onMessage(line: string): void {
    let message: z.infer<typeof responseSchema>
    try {
      message = responseSchema.parse(JSON.parse(line))
    } catch {
      this.addLog('engine', 'Ignored a malformed message from the engine.')
      return
    }
    if ('event' in message) {
      if (message.event === 'ready') this.onReady?.()
      else if (message.event === 'progress') {
        this.lastActivity = Date.now()
        this.pending.get(message.id)?.onProgress?.(message.stage)
      } else this.addLog(message.level === 'error' ? 'error' : 'engine', message.message)
      return
    }
    if (!message.id) return
    const waiter = this.pending.get(message.id)
    if (!waiter) return // late reply after a timeout — ignored
    clearTimeout(waiter.timer)
    this.pending.delete(message.id)
    if (message.ok) waiter.resolve(message.result)
    else waiter.reject(new EngineError(message.error.code, message.error.message, message.error.retryable, message.error.submitted ?? null))
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: string | null): void {
    if (this.child !== child) return
    this.child = null
    this.stopHealth()
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new EngineError('ENGINE_CRASHED', 'The automation engine stopped while handling the request. Its outcome is unknown.', true))
      this.pending.delete(id)
    }
    if (this.stopping || this.state === 'stopping') {
      this.setState('stopped')
      return
    }
    if (this.state === 'starting') return // reported by start()
    this.lastError = `The engine exited unexpectedly (code ${code ?? 'none'}${signal ? `, ${signal}` : ''}).`
    this.deps.log.error(`Automation engine crashed: ${this.lastError}`)
    this.setState('crashed')
  }

  private startHealth(): void {
    this.stopHealth()
    this.healthFailures = 0
    this.healthTimer = setInterval(() => void this.healthTick(), HEALTH_EVERY_MS)
    this.healthTimer.unref()
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private async healthTick(): Promise<void> {
    if (this.state !== 'ready' || this.pending.size > 0) return
    if (Date.now() - this.lastActivity > IDLE_STOP_MS) {
      await this.stop('idle')
      return
    }
    try {
      await this.send('engine.health', {}, 5_000)
      this.healthFailures = 0
    } catch {
      this.healthFailures++
      if (this.healthFailures >= 2 && this.child) {
        this.addLog('engine', 'Health check failed twice — restarting the engine on next use.')
        this.child.kill('SIGKILL')
      }
    }
  }

  private addLog(source: EngineLogLine['source'], text: string): void {
    this.logs.push({ at: new Date().toISOString(), source, text: redact(text).slice(0, 500) })
    if (this.logs.length > LOG_LINES) this.logs.shift()
    if (source !== 'engine') this.deps.log.warn(`Engine ${source}: ${redact(text).slice(0, 300)}`)
    this.deps.onChange()
  }

  private readonly stateListeners = new Set<(state: EngineState, previous: EngineState) => void>()

  /** Called on every state change (e.g. to tell the user when recovery is impossible). */
  onState(listener: (state: EngineState, previous: EngineState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private setState(state: EngineState): void {
    if (this.state === state) return
    const previous = this.state
    this.state = state
    this.deps.onChange()
    for (const listener of this.stateListeners) listener(state, previous)
  }
}
