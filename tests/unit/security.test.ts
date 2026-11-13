// The app lock, the device's side of the subscription, and how the two are enforced. The subscription
// checks run against the real activation server code over HTTP (only its clock and email are faked).
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelAccess } from '../../src/shared/ipc/access'
import { IpcChannel } from '../../src/shared/ipc/channels'
import { ACTIVATION_PUBLIC_KEY } from '../../src/shared/config/activation'
import { AccessController, AccessDeniedError } from '../../src/main/services/security/accessController'
import { deriveIdentity } from '../../src/main/services/security/deviceIdentity'
import { activationEndpoint, activationPublicKey } from '../../src/main/services/security/endpoint'
import { PinService, PIN_ATTEMPTS } from '../../src/main/services/security/pinService'
import { ActivationUnavailableError, SubscriptionService } from '../../src/main/services/security/subscriptionService'
// @ts-expect-error plain JavaScript, tested by its own suite
import { ActivationService } from '../../server/src/activation.mjs'
// @ts-expect-error plain JavaScript
import { loadPlans } from '../../server/src/config.mjs'
// @ts-expect-error plain JavaScript
import { openDatabase } from '../../server/src/db.mjs'
// @ts-expect-error plain JavaScript
import { createApp } from '../../server/src/http.mjs'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const errOf = async (p: Promise<unknown>) => { try { await p; return 'none' } catch (e) { return (e as Error).message } }
const dir = mkdtempSync(join(tmpdir(), 'axora-security-'))
const DAY = 86_400_000

// ── PIN ──
{
  let now = 1_800_000_000_000
  const file = join(dir, 'pin.json')
  const make = () => new PinService({ filePath: file, log: log as never, now: () => now })
  let pin = make()
  check('pin: starts unconfigured and locked', !pin.status().configured && !pin.isUnlocked)
  check('pin: verifying before setup is refused', (await errOf(pin.verify('1234'))) !== 'none')
  check('pin: refuses anything but 4 digits', (await errOf(pin.setup('123'))).includes('4 digits') && (await errOf(pin.setup('12345'))).includes('4 digits') && (await errOf(pin.setup('12a4'))).includes('4 digits'))

  const { recoveryCode, status } = await pin.setup('4821')
  check('pin: setup unlocks this session and returns a recovery code', status.unlocked && /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/.test(recoveryCode), recoveryCode)
  check('pin: a second setup cannot replace the PIN', (await errOf(pin.setup('0000'))).includes('already'))

  const stored = readFileSync(file, 'utf8')
  const parsed = JSON.parse(stored)
  check('pin: stored only as salted hashes', !stored.includes('4821') && !stored.includes(recoveryCode) && !stored.includes(recoveryCode.replace(/-/g, '')) && parsed.pin.salt && parsed.pin.hash)
  const a = new PinService({ filePath: join(dir, 'other.json'), log: log as never })
  await a.setup('4821')
  check('pin: the same PIN hashes differently each time', JSON.parse(readFileSync(join(dir, 'other.json'), 'utf8')).pin.hash !== parsed.pin.hash)

  pin = make()
  check('pin: a restart locks the app again', pin.status().configured && !pin.isUnlocked)
  const wrong = await pin.verify('0000')
  check('pin: wrong PIN is refused and counted', !wrong.ok && !pin.isUnlocked && wrong.status.attemptsLeft === PIN_ATTEMPTS - 1)
  pin = make()
  check('pin: wrong attempts survive a restart', pin.status().attemptsLeft === PIN_ATTEMPTS - 1)
  for (let i = 0; i < 3; i++) await pin.verify('0000')
  const fifth = await pin.verify('0000')
  check('pin: fifth wrong attempt starts a lockout', !fifth.ok && fifth.status.retryAt !== null && fifth.status.attemptsLeft === 0)
  const during = await pin.verify('4821')
  check('pin: even the right PIN is refused during a lockout', !during.ok && !pin.isUnlocked)
  pin = make()
  check('pin: a lockout survives a restart', pin.status().retryAt !== null)
  now += 30_001
  check('pin: lockout ends after 30 seconds', pin.status().retryAt === null)
  for (let i = 0; i < PIN_ATTEMPTS; i++) await pin.verify('0000')
  check('pin: the next lockout is longer', new Date(pin.status().retryAt!).getTime() === now + 60_000)
  now += 60_001
  check('pin: right PIN unlocks and clears the count', (await pin.verify('4821')).ok && pin.isUnlocked && pin.status().attemptsLeft === PIN_ATTEMPTS)

  const parallel = make()
  await Promise.all(Array.from({ length: 12 }, () => parallel.verify('0000')))
  check('pin: parallel guesses cannot outrun the limit', parallel.status().retryAt !== null && JSON.parse(readFileSync(file, 'utf8')).lockouts === 1)
  now += 60_001

  const changer = make()
  const badChange = await changer.change('0000', '1111')
  check('pin: changing needs the current PIN', !badChange.ok)
  check('pin: change works', (await changer.change('4821', '1357')).ok)
  const after = make()
  check('pin: the old PIN stops working after a change', !(await after.verify('4821')).ok && (await after.verify('1357')).ok)

  const forgot = make()
  check('pin: a wrong recovery code is refused', (await errOf(forgot.recover('AAAA-BBBB-CCCC-DDDD', '2468'))).includes('not correct') && !forgot.isUnlocked)
  check('pin: a wrong recovery code counts as an attempt', forgot.status().attemptsLeft === PIN_ATTEMPTS - 1)
  const reset = await forgot.recover(recoveryCode.toLowerCase().replace(/-/g, ' '), '2468')
  check('pin: recovery sets a new PIN and a new code', reset.status.unlocked && reset.recoveryCode !== recoveryCode)
  check('pin: a recovery code works once', (await errOf(make().recover(recoveryCode, '1111'))).includes('not correct'))
  check('pin: the recovered PIN works', (await make().verify('2468')).ok)
}

// ── Activation ID ──
{
  const a = deriveIdentity('machine-a')
  check('device: format XA-XXXX-XXXX-XXXX', /^XA-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(a.activationId), a.activationId)
  check('device: stable for one machine', deriveIdentity('machine-a').activationId === a.activationId && deriveIdentity('machine-a').deviceKey === a.deviceKey)
  check('device: differs between machines', deriveIdentity('machine-b').activationId !== a.activationId)
  check('device: the key cannot be read from the ID', /^[0-9a-f]{64}$/.test(a.deviceKey) && !a.deviceKey.includes(a.activationId.slice(3, 7).toLowerCase()))
  const ids = new Set(Array.from({ length: 2000 }, (_, i) => deriveIdentity(`m${i}`).activationId))
  check('device: no collisions across 2000 machines', ids.size === 2000)
}

// ── Channel levels ──
{
  const channels = Object.values(IpcChannel)
  check('access: the lock screen can reach what it needs', [IpcChannel.PinVerify, IpcChannel.PinStatus, IpcChannel.PinSetup, IpcChannel.PinRecover, IpcChannel.WindowClose].every((c) => channelAccess(c) === 'open'))
  check('access: only a small set is open', channels.filter((c) => channelAccess(c) === 'open').length <= 11)
  check('access: changing the PIN needs the PIN', channelAccess(IpcChannel.PinChange) === 'unlocked')
  check('access: subscription pages need only the PIN, so renewal is always reachable', [IpcChannel.SubscriptionPlans, IpcChannel.SubscriptionRequestOtp, IpcChannel.SubscriptionVerifyOtp].every((c) => channelAccess(c) === 'unlocked'))
  check(
    'access: everything acting on X or generating is premium',
    [IpcChannel.PublishingPublishNow, IpcChannel.PublishingSchedule, IpcChannel.RunsStart, IpcChannel.RunsResume, IpcChannel.GeneratorGenerate, IpcChannel.ImagesGenerate, IpcChannel.QueueRetry, IpcChannel.EngineStart, IpcChannel.ControlResume, IpcChannel.AccountsOpenProfile].every((c) => channelAccess(c) === 'premium')
  )
  check('access: stopping things is never premium', [IpcChannel.RunsStop, IpcChannel.RunsPause, IpcChannel.ControlPause, IpcChannel.ControlStopNow, IpcChannel.QueueCancel, IpcChannel.PublishingUnschedule].every((c) => channelAccess(c) !== 'premium'))
  check('access: backups stay available without a subscription', channelAccess(IpcChannel.BackupCreate) === 'unlocked')

  const pin = { isUnlocked: false }
  const subscription = { isActive: false }
  const calls: string[] = []
  const access = new AccessController({ pin, subscription, log: log as never, startAutomation: () => void calls.push('start'), stopAutomation: async () => void calls.push('stop') })
  const denied = (channel: Parameters<typeof access.guard>[0]) => {
    try {
      access.guard(channel)
      return 'allowed'
    } catch (error) {
      return (error as AccessDeniedError).code
    }
  }
  check('guard: locked, open channels pass and others do not', denied(IpcChannel.PinVerify) === 'allowed' && denied(IpcChannel.DraftsList) === 'LOCKED' && denied(IpcChannel.RunsStart) === 'LOCKED')
  subscription.isActive = true
  check('guard: a subscription does not bypass the PIN', denied(IpcChannel.DraftsList) === 'LOCKED' && denied(IpcChannel.RunsStart) === 'LOCKED')
  await access.sync()
  check('guard: automation waits for the PIN', calls.length === 0 && !access.automationAllowed)
  subscription.isActive = false
  pin.isUnlocked = true
  check('guard: the PIN does not grant premium', denied(IpcChannel.DraftsList) === 'allowed' && denied(IpcChannel.RunsStart) === 'SUBSCRIPTION_REQUIRED')
  await access.sync()
  check('guard: automation waits for the subscription', calls.length === 0)
  subscription.isActive = true
  check('guard: both passing allows premium', denied(IpcChannel.RunsStart) === 'allowed')
  await access.sync()
  await access.sync()
  check('guard: automation starts once', calls.join() === 'start')
  subscription.isActive = false
  await Promise.all([access.sync(), access.sync()])
  check('guard: automation stops once when the subscription ends', calls.join() === 'start,stop' && denied(IpcChannel.RunsStart) === 'SUBSCRIPTION_REQUIRED')
}

// ── Endpoint ──
{
  const env = { XAUTO_ACTIVATION_URL: 'http://evil.example', XAUTO_ACTIVATION_PUBLIC_KEY: 'evil' }
  check('endpoint: an installed app ignores environment overrides', activationEndpoint(true, env) === null && activationPublicKey(true, env) === ACTIVATION_PUBLIC_KEY)
  check('endpoint: development may point elsewhere', activationEndpoint(false, env) === 'http://evil.example' && activationPublicKey(false, env) === 'evil')
  check('endpoint: development defaults to a local server', activationEndpoint(false, {}) === 'http://127.0.0.1:8787')
}

// ── Subscription on the device, against the real server ──
{
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  let now = Date.UTC(2026, 0, 15, 12)
  const mail: { otp: string }[] = []
  const db = openDatabase(':memory:')
  const plans = loadPlans({ PLAN_CURRENCY: 'TST', PLAN_MONTHLY_PRICE: '10', PLAN_SIX_MONTHS_PRICE: '50', PLAN_LIFETIME_PRICE: '100' })
  const server = new ActivationService({ db, config: { plans, otpPepper: 'p'.repeat(32), privateKey, leaseMs: 7 * DAY }, mailer: { sendOtp: async (d: { otp: string }) => void mail.push(d) }, now: () => now })
  const http = createApp(server)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`

  const identity = deriveIdentity('customer-machine')
  const file = join(dir, 'subscription.json')
  let online = true
  let changes = 0
  const fetcher = (url: string, init: RequestInit) => (online ? fetch(url, init) : Promise.reject(new Error('offline')))
  const make = (over: Partial<ConstructorParameters<typeof SubscriptionService>[0]> = {}) =>
    new SubscriptionService({ filePath: file, identity, publicKey: spki, baseUrl, fetch: fetcher, log: log as never, now: () => now, onChange: () => void changes++, ...over })
  const sub = make()

  check('sub: starts inactive', !sub.isActive && sub.status().state === 'none')
  check('sub: plans and prices come from the server', (await sub.plans()).map((p) => `${p.id}:${p.price}`).join() === 'monthly:10,six_months:50,lifetime:100')
  check('sub: a code cannot be guessed before one is requested', (await errOf(sub.verifyOtp('monthly', '123456'))).includes('not correct'))
  const requested = await sub.requestOtp('monthly')
  check('sub: requesting returns only the expiry', Object.keys(requested).join() === 'expiresAt' && new Date(requested.expiresAt).getTime() === now + 600_000)
  const code = mail.at(-1)!.otp
  const wrongCode = code === '000000' ? '000001' : '000000'
  check('sub: a wrong code does not activate', (await errOf(sub.verifyOtp('monthly', wrongCode))).includes('not correct') && !sub.isActive)
  check('sub: the right code for the wrong plan does not activate', (await errOf(sub.verifyOtp('lifetime', code))).includes('not correct') && !sub.isActive)
  const activated = await sub.verifyOtp('monthly', code)
  check('sub: the right code activates at once', sub.isActive && activated.state === 'active' && activated.plan === 'monthly', JSON.stringify(activated))
  check('sub: a used code is refused', (await errOf(sub.verifyOtp('monthly', code))).includes('already been used'))
  check('sub: the code never reaches the device file', !readFileSync(file, 'utf8').includes(code))

  check('sub: activation survives a restart without the server', make({ fetch: () => Promise.reject(new Error('offline')) }).isActive)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), plan: 'lifetime', expiresAt: null }))
  check('sub: editing the file changes nothing that is enforced', make().status().plan === 'monthly' && make().status().expiresAt !== null)

  const stored = JSON.parse(readFileSync(file, 'utf8'))
  const claims = JSON.parse(Buffer.from(stored.token.split('.')[0], 'base64url').toString('utf8'))
  const forge = (payload: object, key = privateKey) => {
    const bytes = Buffer.from(JSON.stringify(payload))
    return `${bytes.toString('base64url')}.${sign(null, bytes, key).toString('base64url')}`
  }
  const withToken = (token: string) => {
    writeFileSync(file, JSON.stringify({ ...stored, token }))
    return make()
  }
  check('sub: a token signed by another key is refused', !withToken(forge({ ...claims, leaseUntil: '2099-01-01T00:00:00.000Z' }, other.privateKey)).isActive)
  const [, signature] = stored.token.split('.')
  check('sub: a token with an altered payload is refused', !withToken(`${Buffer.from(JSON.stringify({ ...claims, plan: 'lifetime' })).toString('base64url')}.${signature}`).isActive)
  check('sub: a token for another device is refused', !withToken(forge({ ...claims, activationId: 'XA-2222-3333-4444' })).isActive)
  check('sub: a garbled token is refused without crashing', !withToken('not-a-token').isActive && !withToken('a.b').isActive)
  writeFileSync(file, JSON.stringify(stored))

  const restored = make()
  check('sub: a genuine token is accepted', restored.isActive)

  // Lease
  now += 6 * DAY
  check('sub: works offline within the lease', make({ fetch: () => Promise.reject(new Error('offline')) }).isActive)
  now += 2 * DAY
  const lapsed = make({ fetch: () => Promise.reject(new Error('offline')) })
  check('sub: stops once the lease ends with no contact', !lapsed.isActive && lapsed.status().state === 'stale')
  await lapsed.refresh()
  check('sub: an offline refresh changes nothing', lapsed.status().state === 'stale')
  await restored.refresh()
  check('sub: reconnecting renews the lease', restored.isActive && restored.status().state === 'active')

  // Clock
  const saved = now
  now -= 2 * DAY
  check('sub: winding the clock back does not extend a lease', !make().isActive, new Date(now).toISOString())
  now = saved
  check('sub: and the correct time restores it', make().isActive)

  // A PC whose clock disagrees with the server (a wrong timezone is enough) can still activate.
  const skewed = make({ identity: deriveIdentity('wrong-timezone'), filePath: join(dir, 'skewed.json'), now: () => now - 5 * 3_600_000 })
  await skewed.requestOtp('monthly')
  check('sub: a device clock hours behind the server can activate', (await skewed.verifyOtp('monthly', mail.at(-1)!.otp)).state === 'active' && skewed.isActive)
  mail.pop()

  // Expiry
  const watcher = make()
  now = Date.UTC(2026, 0, 15, 12) + 30 * DAY
  check('sub: expiry ends access with no contact', !watcher.isActive && watcher.status().state === 'expired')
  await watcher.refresh()
  check('sub: the server confirms expiry', watcher.status().state === 'expired' && JSON.parse(readFileSync(file, 'utf8')).token === null)
  await watcher.requestOtp('six_months')
  const renewed = await watcher.verifyOtp('six_months', mail.at(-1)!.otp)
  check('sub: renewing restores access at once', watcher.isActive && renewed.plan === 'six_months')

  // Revocation
  const before = changes
  server.revoke(identity.activationId, 'test')
  check('sub: revocation reaches the device at its next check', (await watcher.refresh()).state === 'revoked' && !watcher.isActive && changes > before)
  check('sub: a revoked device stays blocked after a restart', make().status().state === 'revoked' && !make().isActive)
  check('sub: a revoked device cannot request a code', (await errOf(watcher.requestOtp('monthly'))).includes('revoked'))
  server.reinstate(identity.activationId)
  check('sub: reinstating restores access', (await watcher.refresh()).state === 'active' && watcher.isActive)

  // Reinstall, new device
  rmSync(file)
  const reinstalled = make()
  check('sub: after a reinstall the file is gone and access is off', !reinstalled.isActive)
  check('sub: the same device gets its subscription back on the next check', (await reinstalled.refresh()).state === 'active' && reinstalled.isActive && mail.length === 2)

  const replacement = deriveIdentity('new-machine')
  const newDevice = make({ identity: replacement, filePath: join(dir, 'new.json') })
  check('sub: another device is not covered', !newDevice.isActive && (await newDevice.refresh()).state === 'none')
  now += 120_000
  await newDevice.requestOtp('monthly')
  server.transfer(identity.activationId, replacement.activationId)
  check('sub: a transferred subscription moves', (await newDevice.refresh()).state === 'active' && (await reinstalled.refresh()).state === 'none' && !reinstalled.isActive)

  // Failure modes
  check('sub: no server address is reported clearly', (await errOf(make({ baseUrl: null }).plans())).includes('isn’t set up') && make({ baseUrl: null }).status().serviceConfigured === false)
  online = false
  check('sub: unreachable server is a plain message', (await errOf(make().plans())).includes('can’t be reached'))
  online = true
  const unavailable = await make({ fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }) }).plans().catch((e: unknown) => e)
  check('sub: a broken response is a plain message', unavailable instanceof ActivationUnavailableError)

  const bypass = make({ bypass: true, baseUrl: null, filePath: join(dir, 'b.json') })
  check('sub: the test bypass is explicit', bypass.isActive && new PinService({ filePath: join(dir, 'b-pin.json'), log: log as never, bypass: true }).isUnlocked)

  http.close()
  http.closeAllConnections()
}

// ── Activation codes: no server on the customer's side ──
{
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ed25519')
  let now = Date.UTC(2026, 0, 15, 12)
  const admin = new ActivationService({ db: openDatabase(':memory:'), config: { plans: [], otpPepper: 'p'.repeat(32), privateKey, leaseMs: 7 * DAY }, mailer: { sendOtp: async () => {} }, now: () => now })
  const identity = deriveIdentity('offline-customer')
  const file = join(dir, 'offline.json')
  const make = () =>
    new SubscriptionService({
      filePath: file,
      identity,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      baseUrl: null,
      fetch: () => Promise.reject(new Error('there is no server')),
      log: log as never,
      now: () => now,
      onChange: () => undefined
    })
  const app = make()
  check('code: no server, starts inactive', !app.isActive && app.status().serviceConfigured === false)
  const monthly = admin.issueCode(identity.activationId, 'monthly').code
  const shown = await app.applyCode(`  ${monthly.slice(0, 40)}\n${monthly.slice(40)}  `)
  check('code: a pasted code activates (spaces and line breaks ignored)', app.isActive && shown.plan === 'monthly' && shown.state === 'active')
  check('code: survives a restart', make().isActive)
  check('code: Check now without a server keeps it', (await app.refresh()).state === 'active')
  now += 29 * DAY
  check('code: still active a day before the end, offline', make().isActive)
  now += DAY
  check('code: ends exactly when the plan does', !make().isActive && make().status().state === 'expired')
  const renewed = admin.issueCode(identity.activationId, 'monthly').code
  check('code: a renewal code restores it', (await make().applyCode(renewed)).state === 'active')

  const otherDevice = admin.issueCode(deriveIdentity('someone-else').activationId, 'lifetime').code
  check('code: another device’s code is refused', (await errOf(make().applyCode(otherDevice))).includes('another device'))
  const [payload, signature] = renewed.split('.')
  const upgraded = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), plan: 'lifetime', leaseUntil: '2100-01-01T00:00:00.000Z' })).toString('base64url')
  check('code: an edited code is refused', (await errOf(make().applyCode(`${upgraded}.${signature}`))).includes('isn’t valid'))
  const forgedAdmin = new ActivationService({ db: openDatabase(':memory:'), config: { plans: [], otpPepper: 'p'.repeat(32), privateKey: other.privateKey, leaseMs: DAY }, mailer: { sendOtp: async () => {} }, now: () => now })
  check('code: a code made with any other key is refused', (await errOf(make().applyCode(forgedAdmin.issueCode(identity.activationId, 'lifetime').code))).includes('isn’t valid'))
  check('code: garbage is refused', (await errOf(make().applyCode('hello'))).includes('isn’t valid') && (await errOf(make().applyCode('a.b.c'))).includes('isn’t valid'))
  check('code: refusals leave the subscription as it was', make().isActive && make().status().plan === 'monthly')
  now += 60 * DAY
  check('code: an expired code is refused', (await errOf(make().applyCode(renewed))).includes('expired'))
  const lifetime = admin.issueCode(identity.activationId, 'lifetime').code
  await make().applyCode(lifetime)
  now += 50 * 365 * DAY
  check('code: Lifetime still active fifty years later', make().isActive && make().status().expiresAt === null)
  check('endpoint: development can behave like a build without a server', activationEndpoint(false, { XAUTO_ACTIVATION_URL: 'none' }) === null)
}

rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
console.log(results.join('\n'))
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
