// Email OTP activation with no server, in a packaged or installed Windows build, driven through its
// screens. SMTP goes to a local capture server, so the test can read the OTP the administrator would get.
//   node tests/e2e/email-otp.e2e.mjs "<path to X Auto.exe>" [screenshot-folder]
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.argv[2]
const positional = process.argv.slice(3).filter((a) => !a.startsWith('--'))
const shots = positional[0] ?? null
// A team-installer test build: the settings are built in (pointing at this fixed port), not given here.
const builtInPort = process.argv.find((a) => a.startsWith('--built-in-port='))?.split('=')[1]
// After activating, open this public build (no settings) with the same data, as after an update.
const publicExe = process.argv.find((a) => a.startsWith('--public-exe='))?.slice('--public-exe='.length)
if (!exe || !existsSync(exe)) {
  console.log('Usage: node tests/e2e/email-otp.e2e.mjs "<path to X Auto.exe>" [screenshot-folder]')
  process.exit(2)
}
if (shots) mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + String(extra).slice(0, 200) : ''}`)
  console.log(results.at(-1))
}
const home = mkdtempSync(join(tmpdir(), 'xauto-email-otp-'))
const SMTP_PASS = 'test-pass-qwerty-1234'

// ── a local SMTP server that keeps what it receives ──
const mail = []
const sink = createServer((socket) => {
  let inData = false
  let message = { to: [], data: '' }
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.write('220 sink\r\n')
  socket.on('data', (chunk) => {
    for (const line of chunk.split('\r\n')) {
      if (inData) {
        if (line === '.') {
          inData = false
          mail.push(message)
          message = { to: [], data: '' }
          socket.write('250 stored\r\n')
        } else message.data += `${line}\n`
      } else if (/^EHLO/i.test(line)) socket.write('250-sink\r\n250 AUTH PLAIN LOGIN\r\n')
      else if (/^AUTH/i.test(line)) socket.write('235 ok\r\n')
      else if (/^MAIL FROM/i.test(line)) socket.write('250 ok\r\n')
      else if (/^RCPT TO/i.test(line)) message.to.push(/<(.+)>/.exec(line)[1]), socket.write('250 ok\r\n')
      else if (/^DATA/i.test(line)) (inData = true), socket.write('354 go\r\n')
      else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n')
      else if (line) socket.write('250 ok\r\n')
    }
  })
})
await new Promise((resolve) => sink.listen(builtInPort ? Number(builtInPort) : 0, '127.0.0.1', resolve))
const otpOf = () => /OTP: (\d{6})/.exec(mail.at(-1)?.data ?? '')?.[1]

const finish = async (app) => {
  if (app) await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))])
  sink.close()
  console.log(`\n${results.filter((r) => r.startsWith('FAIL')).length} failed of ${results.length}`)
  setTimeout(() => {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
    process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
  }, 500)
}

// ── the installed files hold no secrets ──
const installDir = join(exe, '..')
const scan = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? scan(path) : [path]
})
const appFiles = scan(join(installDir, 'resources')).filter((p) => /\.(asar|js|json|cjs|mjs|yml|env)$/i.test(p))
// The real values come from this PC's own settings, so none of them is written in this file.
const realSecrets = [process.env.XAUTO_SMTP_PASS, process.env.XAUTO_SMTP_USER, process.env.XAUTO_ADMIN_EMAIL]
  .filter((v) => v && v.trim().length >= 6)
  .flatMap((v) => [v.trim(), v.replace(/\s+/g, '')])
const leaked = appFiles.filter((p) => {
  const text = readFileSync(p).toString('latin1')
  return /SIGNING_PRIVATE_KEY=|OTP_PEPPER=/.test(text) || realSecrets.some((secret) => text.includes(secret))
})
if (builtInPort) check('team build: settings are built in on purpose, so the secret scan is skipped', true)
else check('real SMTP settings were available to look for', realSecrets.length > 0 || process.env.XAUTO_SKIP_SECRET_SCAN === '1')
if (!builtInPort) check('the installed app files contain no SMTP password, admin address or private key', leaked.length === 0, leaked.join(', '))

const env = {
  ...process.env,
  XAUTO_SMTP_HOST: '127.0.0.1',
  XAUTO_SMTP_PORT: String(sink.address().port),
  XAUTO_SMTP_SECURE: 'false',
  XAUTO_SMTP_USER: 'sender@example.com',
  XAUTO_SMTP_PASS: SMTP_PASS,
  XAUTO_ADMIN_EMAIL: 'admin@example.com',
  XAUTO_PLAN_CURRENCY: 'PKR',
  XAUTO_PRICE_MONTHLY: '2000'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.AXORA_TEST_SKIP_SECURITY
if (builtInPort) for (const name of Object.keys(env)) if (name.startsWith('XAUTO_')) delete env[name]
const expectedAdmin = builtInPort ? 'team-admin@example.com' : 'admin@example.com'

const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${join(home, 'user-data')}`], env })
try {
  const page = await app.firstWindow()
  await page.waitForSelector('h1', { timeout: 30000 })
  check('this is the packaged app', await app.evaluate(({ app }) => app.isPackaged))
  const call = (path, ...args) =>
    page.evaluate(async ({ path, args }) => {
      try {
        const [group, method] = path.split('.')
        await window.relay[group][method](...args)
        return 'allowed'
      } catch (error) {
        return /\[([A-Z_]+)\]/.exec(error.message)?.[1] ?? error.message
      }
    }, { path, args })
  const body = () => page.evaluate(() => document.body.innerText)
  const typePin = async (pin) => {
    for (const d of pin) await page.keyboard.type(d, { delay: 80 })
    await page.waitForTimeout(500)
  }

  // PIN first
  check('the PIN comes first', (await page.textContent('h1')) === 'Create a PIN')
  await typePin('1357')
  await typePin('1357')
  await page.waitForSelector('[data-testid="recovery-code"]')
  await page.getByRole('checkbox').click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForSelector('nav', { timeout: 20000 })
  check('without activation, premium work is blocked', (await call('runs.start', {})) === 'SUBSCRIPTION_REQUIRED')

  await page.evaluate(() => (window.location.hash = '/settings?section=subscription'))
  await page.waitForSelector('[data-testid="activation-id"]')
  const activationId = await page.textContent('[data-testid="activation-id"]')
  const status = await page.evaluate(() => window.relay.subscription.status())
  check('email OTP mode, read from the environment', status.mode === 'email', status.mode)
  check('no "can’t be reached" or "isn’t set up"', !/can’t be reached|isn’t set up|could not be loaded/.test(await body()))
  check('the window never receives SMTP settings', !JSON.stringify(status).includes('sender@') && !(await body()).includes(SMTP_PASS))
  if (shots) await page.screenshot({ path: join(shots, 'email-01-plans.png') })

  // Request
  await page.getByRole('radio', { name: /Monthly/ }).click()
  await page.getByRole('button', { name: 'Activate', exact: true }).click()
  await page.waitForSelector('#activation-code', { timeout: 30000 })
  const otp = otpOf()
  check('Activate emails a 6-digit OTP', /^\d{6}$/.test(otp ?? ''))
  check('only to the admin address', mail.length === 1 && mail[0].to.join() === expectedAdmin, mail[0]?.to.join())
  check('with Activation ID, plan and expiry', [activationId, 'Plan: Monthly', 'Expires:', ...(builtInPort ? [] : ['PKR 2000'])].every((p) => mail[0].data.includes(p)))
  check('the window never shows the OTP', !(await body()).includes(otp))
  if (shots) await page.screenshot({ path: join(shots, 'email-02-enter-code.png') })

  // Wrong, wrong plan, right, reuse
  await page.fill('#activation-code', otp === '000000' ? '000001' : '000000')
  await page.getByRole('button', { name: 'Activate subscription' }).click()
  await page.waitForSelector('text=That code is not correct')
  check('a wrong OTP is refused', (await call('runs.start', {})) === 'SUBSCRIPTION_REQUIRED')
  check('the right OTP for another plan is refused', (await call('subscription.verifyOtp', 'lifetime', otp)) === 'VALIDATION')
  await page.fill('#activation-code', otp)
  await page.getByRole('button', { name: 'Activate subscription' }).click()
  await page.waitForSelector('text=Subscription activated', { timeout: 15000 })
  const active = await page.evaluate(() => window.relay.subscription.status())
  check('the right OTP activates Monthly at once', active.state === 'active' && active.plan === 'monthly', JSON.stringify(active))
  check('premium work is allowed now', (await call('runs.start', {})) !== 'SUBSCRIPTION_REQUIRED')
  check('the same OTP can’t be used again', (await call('subscription.verifyOtp', 'monthly', otp)) === 'VALIDATION')
  if (shots) await page.screenshot({ path: join(shots, 'email-03-active.png') })

  // Nothing secret on disk
  const security = join(home, 'user-data', 'security')
  const written = readdirSync(security).map((f) => readFileSync(join(security, f), 'utf8')).join('')
  check('no OTP or SMTP password in the app’s saved files', !written.includes(otp) && !written.includes(SMTP_PASS) && !written.includes('team-test-pass-5678'))
  const logs = JSON.stringify(await page.evaluate(() => window.relay.logs.list({ limit: 2000 })))
  check('the app’s logs were read and record the request', logs.includes('OTP emailed to the administrator') && logs.includes('OTP accepted'))
  check('no OTP or SMTP password in the app’s logs', !logs.includes(otp) && !logs.includes(SMTP_PASS))
} catch (error) {
  check('crashed', false, String(error).split('\n')[0])
}

if (publicExe) {
  // The public update has no settings of its own: it must use the ones kept on this PC.
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))])
  const later = await electron.launch({ executablePath: publicExe, args: [`--user-data-dir=${join(home, 'user-data')}`], env })
  try {
    const page = await later.firstWindow()
    await page.waitForSelector('h1', { timeout: 30000 })
    for (const d of '1357') await page.keyboard.type(d, { delay: 80 })
    await page.waitForSelector('nav', { timeout: 20000 })
    const status = await page.evaluate(() => window.relay.subscription.status())
    check('after a public update: still email OTP mode, with no settings on the PC', status.mode === 'email', status.mode)
    check('after a public update: still active', status.state === 'active' && status.plan === 'monthly')
    const before = mail.length
    // One request a minute: wait out the first one.
    await page.waitForTimeout(61_000)
    await page.evaluate(() => (window.location.hash = '/settings?section=subscription'))
    await page.waitForSelector('[data-testid="activation-id"]')
    await page.getByRole('radio', { name: /6 Months/ }).click()
    await page.getByRole('button', { name: 'Activate', exact: true }).click()
    await page.waitForSelector('#activation-code', { timeout: 30000 })
    check('after a public update: Activate still emails the admin', mail.length === before + 1 && mail.at(-1).to.join() === expectedAdmin)
  } catch (error) {
    check('public update step crashed', false, String(error).split('\n')[0])
  }
  await finish(later)
} else await finish(app)
