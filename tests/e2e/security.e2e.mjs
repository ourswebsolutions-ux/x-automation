// PIN and subscription in the real app: a development build driven through its screens, against the
// real activation server code on loopback (only its email is captured and its clock movable).
// Needs `npm run build` first.   node tests/e2e/security.e2e.mjs [screenshot-folder]
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ActivationService } from '../../server/src/activation.mjs'
import { loadPlans } from '../../server/src/config.mjs'
import { openDatabase } from '../../server/src/db.mjs'
import { createApp } from '../../server/src/http.mjs'

const project = join(dirname(fileURLToPath(import.meta.url)), '../..')
const shots = process.argv[2] ?? null
if (shots) mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + String(extra).slice(0, 300) : ''}`); console.error(results.at(-1)) }
const home = mkdtempSync(join(tmpdir(), 'axora-security-e2e-'))
const report = (code) => {
  console.log(results.join('\n'))
  console.log(`\n${results.filter((r) => r.startsWith('FAIL')).length} failed of ${results.length}`)
  http.close()
  http.closeAllConnections()
  setTimeout(() => {
    // Windows can hold a just-closed profile folder open; a leftover temp folder is harmless.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    } catch {}
    process.exit(code)
  }, 500)
}
const crash = (error) => {
  results.push(`FAIL  crashed: ${String(error?.stack ?? error).split('\n').slice(0, 5).join(' | ')}`)
  report(1)
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

// ── The activation server ──
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
let clockOffset = 0
const mail = []
const plans = loadPlans({ PLAN_CURRENCY: 'TST', PLAN_MONTHLY_PRICE: '11', PLAN_MONTHLY_DAYS: '30', PLAN_SIX_MONTHS_PRICE: '55', PLAN_LIFETIME_PRICE: '111' })
const service = new ActivationService({
  db: openDatabase(':memory:'),
  config: { plans, otpPepper: 'e'.repeat(32), privateKey, leaseMs: 7 * 86_400_000 },
  mailer: { sendOtp: async (details) => void mail.push(details) },
  now: () => Date.now() + clockOffset
})
const http = createApp(service)
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))

async function launch() {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: home,
    XAUTO_ACTIVATION_URL: `http://127.0.0.1:${http.address().port}`,
    XAUTO_ACTIVATION_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AXORA_TEST_SKIP_SECURITY
  const app = await electron.launch({ executablePath: electronPath, args: [`--user-data-dir=${join(home, 'user-data')}`, '--disable-backgrounding-occluded-windows', project], env, cwd: project })
  const page = await app.firstWindow()
  await page.waitForSelector('h1', { timeout: 20000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
  return { app, page }
}
const snap = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
const typePin = async (page, pin, delay = 0) => {
  for (const digit of pin) await page.keyboard.type(digit, { delay })
  await page.waitForTimeout(500)
}
/** Calls the bridge the way a compromised page would, and reports the outcome. */
const call = (page, path, ...args) =>
  page.evaluate(
    async ({ path, args }) => {
      try {
        const [group, method] = path.split('.')
        await window.relay[group][method](...args)
        return 'allowed'
      } catch (error) {
        return /\[([A-Z_]+)\]/.exec(error.message)?.[1] ?? error.message
      }
    },
    { path, args }
  )
const body = (page) => page.evaluate(() => document.body.innerText)
const goSubscription = async (page) => {
  await page.evaluate(() => (window.location.hash = '/settings?section=subscription'))
  await page.waitForSelector('[data-testid="activation-id"]', { timeout: 10000 })
}

let { app, page } = await launch()

// ── First run: PIN ──
check('first run asks for a PIN before anything else', (await page.textContent('h1')) === 'Create a PIN')
check('locked: data channels are refused', (await call(page, 'drafts.list')) === 'LOCKED')
check('locked: settings changes are refused', (await call(page, 'preferences.update', { theme: 'light' })) === 'LOCKED')
check('locked: subscription channels are refused', (await call(page, 'subscription.status')) === 'LOCKED')
await snap(page, '01-create-pin')
await typePin(page, '4821')
check('confirm step', (await page.textContent('h1')) === 'Confirm your PIN')
await typePin(page, '9999')
check('a mismatch starts again', (await page.textContent('h1')) === 'Create a PIN' && (await body(page)).includes('didn’t match'))
await typePin(page, '4821', 180)
check('human-speed typing reaches the confirm step after a mismatch', (await page.textContent('h1')) === 'Confirm your PIN')
await typePin(page, '4821', 180)
await page.waitForSelector('[data-testid="recovery-code"]')
const recoveryCode = await page.textContent('[data-testid="recovery-code"]')
check('recovery code is shown once', /^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/.test(recoveryCode), recoveryCode)
const continueButton = page.getByRole('button', { name: 'Continue' })
check('continuing needs confirmation', await continueButton.isDisabled())
await snap(page, '02-recovery-code')
await page.getByRole('checkbox').click()
await continueButton.click()
await page.waitForSelector('text=X Auto isn’t activated', { timeout: 15000 })

// ── No subscription ──
check('the PIN opens the app, with a banner', true)
await snap(page, '03-dashboard-not-activated')
check('without a subscription, viewing works', (await call(page, 'drafts.list')) === 'allowed')
for (const [path, ...args] of [['generator.generate', {}], ['runs.start', {}], ['publishing.publishNow', {}], ['engine.start'], ['drafts.save', {}], ['ixbrowser.sync']]) {
  check(`without a subscription, ${path} is refused`, (await call(page, path, ...args)) === 'SUBSCRIPTION_REQUIRED')
}

await goSubscription(page)
const activationId = await page.textContent('[data-testid="activation-id"]')
check('Activation ID is shown in its format', /^XA-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/.test(activationId), activationId)
check('plans and prices come from the server', await page.getByRole('radiogroup').innerText().then((text) => ['TST 11', 'TST 55', 'TST 111', '30 days', '6 months', 'Never expires'].every((part) => text.includes(part))))
await snap(page, '04-subscription')
await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForSelector('text=Activation ID copied')
check('Copy puts the Activation ID on the clipboard', (await app.evaluate(({ clipboard }) => clipboard.readText())) === activationId)

// ── Wrong plan, wrong code, right code ──
await page.getByRole('radio', { name: /Monthly/ }).click()
await page.getByRole('button', { name: 'Activate', exact: true }).click()
await page.waitForSelector('#activation-code')
check('clicking Activate emails the administrator only', mail.length === 1 && mail[0].activationId === activationId && mail[0].planName === 'Monthly' && mail[0].priceLabel === 'TST 11')
check('the page does not hold the OTP', !(await body(page)).includes(mail[0].otp))
await snap(page, '05-enter-code')
const otp = mail[0].otp
await page.fill('#activation-code', otp === '000000' ? '000001' : '000000')
await page.getByRole('button', { name: 'Activate subscription' }).click()
await page.waitForSelector('text=That code is not correct', { timeout: 10000 })
check('a wrong code is refused on screen', true)
await snap(page, '06-wrong-code')
check('a code for another plan is refused', (await call(page, 'subscription.verifyOtp', 'lifetime', otp)) === 'VALIDATION')
await page.fill('#activation-code', otp)
await page.getByRole('button', { name: 'Activate subscription' }).click()
await page.waitForSelector('text=Active', { timeout: 10000 })
await page.waitForFunction(() => document.querySelector('[data-testid="activation-id"]') && document.body.innerText.includes('Monthly'))
check('the right code activates immediately', !(await body(page)).includes('Not activated'))
check('reusing it is refused', (await call(page, 'subscription.verifyOtp', 'monthly', otp)) === 'VALIDATION')
await snap(page, '07-active')
const statusShown = await page.evaluate(() => window.relay.subscription.status())
check('status is stored and displayed', statusShown.state === 'active' && statusShown.plan === 'monthly' && statusShown.activationId === activationId && (await body(page)).includes('Monthly'))
check('with both layers, premium channels reach their handlers', (await call(page, 'drafts.save', {})) !== 'SUBSCRIPTION_REQUIRED')
await page.evaluate(() => (window.location.hash = '/dashboard'))
await page.waitForTimeout(600)
check('the banner is gone', !(await body(page)).includes('isn’t activated'))

// ── PIN change ──
await page.evaluate(() => (window.location.hash = '/settings?section=security'))
await page.waitForSelector('#pin-current')
await page.fill('#pin-current', '0000')
await page.fill('#pin-next', '1357')
await page.fill('#pin-confirm', '1357')
await page.getByRole('button', { name: 'Change PIN' }).click()
await page.waitForSelector('text=The current PIN is not correct')
check('changing the PIN needs the current one', true)
await page.fill('#pin-current', '4821')
await page.getByRole('button', { name: 'Change PIN' }).click()
await page.waitForSelector('text=PIN changed')
check('the PIN can be changed', true)
await snap(page, '08-pin-change')

// ── Restart ──
await app.close()
;({ app, page } = await launch())
check('reopening asks for the PIN', (await page.textContent('h1')) === 'Enter your PIN')
check('an active subscription does not bypass the PIN', (await call(page, 'drafts.list')) === 'LOCKED' && (await call(page, 'runs.active')) === 'LOCKED')
await typePin(page, '4821')
check('the old PIN no longer works', (await body(page)).includes('Wrong PIN. 4 attempts left'))
await snap(page, '09-wrong-pin')
for (let i = 0; i < 4; i++) await typePin(page, '0000')
await page.waitForSelector('text=Too many wrong attempts')
check('five wrong PINs lock entry', await page.getByLabel('Digit 1 of 4').isDisabled())
await snap(page, '10-pin-lockout')
await app.close()
;({ app, page } = await launch())
check('the lockout survives reopening the app', (await body(page)).includes('Too many wrong attempts'))
// Everything the app wrote about this device: database, write-ahead log, security files.
const stored = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? stored(path) : [readFileSync(path).toString('latin1')]
})
const written = [...stored(join(home, 'user-data', 'data')), ...stored(join(home, 'user-data', 'security'))].join('')
check('no OTP in the desktop database, logs or security files', !mail.some(({ otp: code }) => written.includes(code)))
check('no SMTP settings on the desktop', !/smtp|OTP_PEPPER|SIGNING_PRIVATE_KEY/i.test(stored(join(home, 'user-data', 'security')).join('')))
const pinFile = readFileSync(join(home, 'user-data', 'security', 'pin.json'), 'utf8')
check('the PIN file holds no PIN', !pinFile.includes('1357') && existsSync(join(home, 'user-data', 'security', 'pin.json')))

await page.getByRole('button', { name: 'Forgot your PIN?' }).click()
await page.fill('#recovery-code', 'AAAA-BBBB-CCCC-DDDD')
await page.fill('#recovery-pin', '2468')
await page.getByRole('button', { name: 'Reset PIN' }).click()
await page.waitForSelector('[role="alert"]')
check('during a lockout, recovery is refused as well', (await body(page)).includes('Too many wrong attempts'))
await page.getByRole('button', { name: 'Back' }).click()
await page.waitForFunction(() => !document.body.innerText.includes('Try again in'), null, { timeout: 40000 })
await page.getByRole('button', { name: 'Forgot your PIN?' }).click()
await page.fill('#recovery-code', recoveryCode)
await page.fill('#recovery-pin', '2468')
await page.getByRole('button', { name: 'Reset PIN' }).click()
await page.waitForSelector('[data-testid="recovery-code"]')
check('the recovery code resets the PIN and issues a new code', (await page.textContent('[data-testid="recovery-code"]')) !== recoveryCode)
await page.getByRole('checkbox').click()
await page.getByRole('button', { name: 'Continue' }).click()
await page.waitForSelector('nav', { timeout: 15000 })
await page.waitForTimeout(800)
check('the subscription survived all of that', !(await body(page)).includes('isn’t activated') && !(await body(page)).includes('expired'))

// ── Revocation and expiry reach the running app ──
await goSubscription(page)
service.revoke(activationId, 'e2e')
await page.getByRole('button', { name: 'Check now' }).click()
await page.waitForSelector('text=This subscription was revoked', { timeout: 10000 })
check('revocation blocks premium at once', (await call(page, 'runs.start', {})) === 'SUBSCRIPTION_REQUIRED')
await snap(page, '11-revoked')
await page.evaluate(() => (window.location.hash = '/dashboard'))
await page.waitForSelector('text=Your subscription was revoked')
check('the app stays usable for viewing while revoked', (await call(page, 'drafts.list')) === 'allowed')
service.reinstate(activationId)
await goSubscription(page)
await page.getByRole('button', { name: 'Check now' }).click()
await page.waitForFunction(() => !document.body.innerText.includes('This subscription was revoked'))
check('reinstating restores it', (await call(page, 'drafts.save', {})) !== 'SUBSCRIPTION_REQUIRED')

clockOffset = 31 * 86_400_000
await page.getByRole('button', { name: 'Check now' }).click()
await page.waitForSelector('text=Renew or change plan', { state: 'hidden', timeout: 10000 }).catch(() => undefined)
await page.waitForSelector('text=Expired', { timeout: 10000 })
check('expiry blocks premium', (await call(page, 'runs.start', {})) === 'SUBSCRIPTION_REQUIRED')
await snap(page, '12-expired')

clockOffset += 3_600_000
await page.getByRole('radio', { name: /6 Months/ }).click()
await page.getByRole('button', { name: 'Activate', exact: true }).click()
await page.waitForSelector('#activation-code')
await page.fill('#activation-code', mail.at(-1).otp)
clockOffset += 10 * 60_000
await page.getByRole('button', { name: 'Activate subscription' }).click()
await page.waitForSelector('text=That code has expired', { timeout: 10000 })
check('a code is refused after 10 minutes', (await call(page, 'runs.start', {})) === 'SUBSCRIPTION_REQUIRED')
await snap(page, '13-code-expired')

await page.getByRole('button', { name: 'Cancel' }).click()
await page.getByRole('radio', { name: /6 Months/ }).click()
await page.getByRole('button', { name: 'Activate', exact: true }).click()
await page.waitForSelector('#activation-code')
await page.fill('#activation-code', mail.at(-1).otp)
await page.getByRole('button', { name: 'Activate subscription' }).click()
await page.waitForSelector('text=Subscription activated', { timeout: 10000 })
check('renewing restores access', (await call(page, 'drafts.save', {})) !== 'SUBSCRIPTION_REQUIRED')

const closed = await Promise.race([app.close().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20000))])
check('the app shuts down after automation stopped and restarted', closed)
report(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
