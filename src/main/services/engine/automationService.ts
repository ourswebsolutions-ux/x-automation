import { join } from 'node:path'
import type { CompatStep, CompatibilityResult, EngineSelfCheck } from '@shared/types/engine'
import type { SettingsRepository } from '../database/repositories'
import type { ProfileRepository } from '../database/sqlite/profileRepository'
import { NotFoundError } from '../errors'
import { IxBrowserError } from '../integrations/ixbrowser/client'
import type { IxBrowserService } from '../integrations/ixbrowser/ixBrowserService'
import type { ScopedLogger } from '../logging/logger'
import { EngineError, type EngineService } from './engineService'

interface Deps {
  engine: EngineService
  ixBrowser: IxBrowserService
  profiles: ProfileRepository
  settings: SettingsRepository
  log: ScopedLogger
  onChange: () => void
}

const RESULT_KEY = (profileId: string) => `automation.compat.${profileId}`
const SELF_CHECK_KEY = 'automation.engineSelfCheck'

interface SelfTestResult {
  ok: boolean
  steps: { step: string; ok: boolean; ms: number; title?: string; file?: string; browserVersion?: string; pagesBefore?: number }[]
  browserVersion: string
  usedExistingContext: boolean
}

/**
 * Browser automation orchestration on top of IX Browser and the Python
 * engine. The compatibility check proves, step by step, that a profile can be
 * automated: IX Browser opens it through the Local API, returns its debugging
 * address, the engine attaches with Playwright's connect_over_cdp, and a
 * controlled page is driven in the profile's own browser context. Nothing is
 * reported as working unless that actually happened.
 */
export class AutomationService {
  private readonly running = new Set<string>()

  constructor(private readonly deps: Deps) {}

  lastResult(profileId: string): CompatibilityResult | null {
    return this.deps.settings.get<CompatibilityResult>(RESULT_KEY(profileId)) ?? null
  }

  lastSelfCheck(): EngineSelfCheck | null {
    return this.deps.settings.get<EngineSelfCheck>(SELF_CHECK_KEY) ?? null
  }

  /** Starts the engine and Playwright's driver for real; records the outcome. */
  async engineSelfCheck(): Promise<EngineSelfCheck> {
    let result: EngineSelfCheck
    try {
      const health = await this.deps.engine.request<{ python: string; playwright: string | null; driverStartMs: number }>('engine.health', { deep: true }, 60_000)
      result = { ok: Boolean(health.playwright), checkedAt: new Date().toISOString(), python: health.python, playwright: health.playwright, driverStartMs: health.driverStartMs ?? null, error: health.playwright ? null : 'Playwright is missing from the engine runtime.' }
    } catch (error) {
      result = { ok: false, checkedAt: new Date().toISOString(), python: null, playwright: null, driverStartMs: null, error: error instanceof Error ? error.message : 'The engine check failed.' }
    }
    this.deps.settings.set(SELF_CHECK_KEY, result)
    this.deps.onChange()
    return result
  }

  async checkProfile(profileId: string): Promise<CompatibilityResult> {
    if (this.running.has(profileId)) throw new EngineError('BUSY', 'A compatibility check for this profile is already running.')
    const profile = this.deps.profiles.get(profileId)
    if (!profile) throw new NotFoundError('That profile is not in the local list. Sync profiles first.')
    this.running.add(profileId)
    const steps: CompatStep[] = []
    const result: CompatibilityResult = {
      profileId,
      externalId: profile.externalId,
      ok: false,
      checkedAt: new Date().toISOString(),
      steps,
      browserVersion: null,
      usedExistingContext: false,
      screenshot: null,
      blocker: null
    }
    const add = (step: CompatStep['step'], ok: boolean, detail: string, ms: number | null = null) => steps.push({ step, ok, detail, ms })
    let openedHere = false
    try {
      if (!this.deps.ixBrowser.activeConfig()) {
        add('ix-connection', false, 'No enabled IX Browser connection is configured.')
        result.blocker = 'Set up the IX Browser connection in Settings → IX Browser first.'
        return result
      }
      add('ix-connection', true, 'IX Browser connection configured.')
      if (profile.availability !== 'available') {
        add('profile-open', false, 'IX Browser no longer reports this profile.')
        result.blocker = 'Sync profiles and choose a profile IX Browser still has.'
        return result
      }

      let address = this.deps.ixBrowser.debuggingAddressFor(profile.externalId)
      if (profile.runState === 'running' && !address) {
        add('debugging-address', false, 'The profile is already open, but it was not opened by X Auto in this session, so its debugging address is unknown.')
        result.blocker = 'This profile is open in IX Browser but wasn’t opened by X Auto. Close it there, then run the check again.'
        return result
      }
      if (!address) {
        const started = Date.now()
        try {
          await this.deps.ixBrowser.openProfile(profile.externalId)
          openedHere = true
          add('profile-open', true, 'Opened through the IX Browser Local API (profile-open).', Date.now() - started)
        } catch (error) {
          add('profile-open', false, error instanceof Error ? error.message : 'IX Browser did not open the profile.', Date.now() - started)
          result.blocker =
            error instanceof IxBrowserError && (error.kind === 'unreachable' || error.kind === 'timeout')
              ? 'Could not reach IX Browser. Check that it is running with the Local API enabled.'
              : 'IX Browser could not open the profile.'
          return result
        }
        address = this.deps.ixBrowser.debuggingAddressFor(profile.externalId)
      }
      if (!address) {
        add('debugging-address', false, 'IX Browser opened the profile but returned no debugging_address.')
        result.blocker = 'IX Browser opened the profile but did not allow automation for it. Your IX Browser version or plan may not support this.'
        return result
      }
      add('debugging-address', true, `IX Browser returned a debugging address (${address}).`)

      const engineStarted = Date.now()
      try {
        await this.deps.engine.ensureStarted()
        const versions = this.deps.engine.status().versions
        add('engine', true, `Automation engine ready — Python ${versions?.python ?? '?'}, Playwright ${versions?.playwright ?? '?'}.`, Date.now() - engineStarted)
      } catch (error) {
        add('engine', false, error instanceof Error ? error.message : 'The automation engine did not start.', Date.now() - engineStarted)
        result.blocker = 'The automation engine could not start. Restart it in Settings → Automation.'
        return result
      }

      const endpoint = /^(https?|wss?):\/\//.test(address) ? address : `http://${address}`
      try {
        const test = await this.deps.engine.request<SelfTestResult & Record<string, unknown>>(
          'browser.selfTest',
          { endpoint, timeoutMs: 20_000, screenshotDir: join(this.deps.engine.diagnosticsDir, 'screenshots') },
          60_000
        )
        for (const s of test.steps) {
          const name = (['connect', 'open-tab', 'navigate', 'interact', 'screenshot', 'close-tab'] as const).find((n) => n === s.step)
          if (!name) continue
          const detail =
            name === 'connect'
              ? `Connected with Playwright connect_over_cdp (${s.browserVersion ?? test.browserVersion}).`
              : name === 'open-tab'
                ? `Opened one tab in the profile’s existing browser context (${s.pagesBefore ?? '?'} tab(s) already open).`
                : name === 'navigate'
                  ? `Navigated to a controlled test page (“${s.title ?? ''}”).`
                  : name === 'interact'
                    ? 'Typed into a field, clicked a button and verified the page’s response.'
                    : name === 'screenshot'
                      ? `Saved a screenshot of the test page (${s.file ?? ''}).`
                      : 'Closed the test tab; the profile’s other tabs were not touched.'
          add(name, s.ok, detail, s.ms)
          if (name === 'screenshot' && s.file) result.screenshot = s.file
        }
        result.browserVersion = test.browserVersion
        result.usedExistingContext = test.usedExistingContext === true
        result.ok = test.ok === true
      } catch (error) {
        const e = error instanceof EngineError ? error : new EngineError('TEST_FAILED', 'The browser test failed.')
        add('connect', false, e.message)
        result.blocker =
          e.code === 'CONNECT_FAILED' || e.code === 'CONNECT_TIMEOUT'
            ? 'X Auto could not connect to the profile’s browser. Check that IX Browser allows automation for this profile.'
            : e.code === 'NO_CONTEXT'
              ? 'The profile’s browser session was not available.'
              : 'The test in the profile’s browser did not complete.'
      }
      return result
    } finally {
      if (openedHere) {
        const started = Date.now()
        try {
          await this.deps.ixBrowser.closeProfile(profile.externalId)
          add('profile-close', true, 'Closed the profile again (the check opened it).', Date.now() - started)
        } catch (error) {
          add('profile-close', false, error instanceof Error ? error.message : 'The profile could not be closed.', Date.now() - started)
        }
      }
      this.running.delete(profileId)
      this.deps.settings.set(RESULT_KEY(profileId), result)
      if (result.ok) this.deps.log.success(`Automation compatibility check passed for profile ${profile.externalId}`)
      else this.deps.log.warn(`Automation compatibility check failed for profile ${profile.externalId}`, { failedStep: steps.find((s) => !s.ok)?.step ?? null })
      this.deps.onChange()
    }
  }
}
