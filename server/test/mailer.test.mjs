// The real mailer talking real SMTP to a local sink, so these are facts about what leaves the server.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { ActivationService } from '../src/activation.mjs'
import { isEmailAddress, loadConfig, loadPlans } from '../src/config.mjs'
import { openDatabase } from '../src/db.mjs'
import { createSmtpMailer } from '../src/mailer.mjs'
import { setAdminEmail } from '../src/runtime.mjs'

const A = 'XA-2345-6789-ABCD'
const SECRET = 'smtp-password-value'
const messages = []
let sink

function startSink() {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let inData = false
      let message = { from: '', to: [], data: '' }
      socket.setEncoding('utf8')
      socket.write('220 sink\r\n')
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        for (const line of chunk.split('\r\n')) {
          if (inData) {
            if (line === '.') {
              inData = false
              messages.push(message)
              message = { from: '', to: [], data: '' }
              socket.write('250 stored\r\n')
            } else message.data += `${line}\n`
          } else if (/^EHLO/i.test(line)) socket.write('250-sink\r\n250 AUTH PLAIN\r\n')
          else if (/^AUTH/i.test(line)) socket.write('235 ok\r\n')
          else if (/^MAIL FROM/i.test(line)) (message.from = line), socket.write('250 ok\r\n')
          else if (/^RCPT TO/i.test(line)) message.to.push(/<(.+)>/.exec(line)[1]), socket.write('250 ok\r\n')
          else if (/^DATA/i.test(line)) (inData = true), socket.write('354 go\r\n')
          else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

before(async () => {
  sink = await startSink()
})
after(() => sink.close())
beforeEach(() => {
  messages.length = 0
})

const config = () => ({
  adminEmail: 'admin@example.com',
  smtp: { host: '127.0.0.1', port: sink.address().port, secure: false, user: 'sender@example.com', pass: SECRET, from: 'sender@example.com' },
  plans: loadPlans({ PLAN_CURRENCY: 'TST', PLAN_MONTHLY_PRICE: '10' }),
  otpPepper: 'p'.repeat(32),
  privateKey: generateKeyPairSync('ed25519').privateKey,
  leaseMs: 86_400_000
})

describe('what leaves the server', () => {
  it('delivers each OTP to the administrator and no one else', async () => {
    const cfg = config()
    const service = new ActivationService({ db: openDatabase(':memory:'), config: cfg, mailer: createSmtpMailer(cfg) })
    await service.requestOtp({ activationId: A, deviceKey: 'a'.repeat(64), plan: 'monthly', ip: '127.0.0.1' })
    assert.equal(messages.length, 1)
    assert.deepEqual(messages[0].to, ['admin@example.com'])
    assert.ok(!/^(cc|bcc):/im.test(messages[0].data))
    assert.ok(!messages[0].data.includes(SECRET))
    const otp = /OTP: (\S+)/.exec(messages[0].data)?.[1]
    assert.match(otp, /^\d{6}$/)
    for (const part of [A, 'Monthly', 'TST 10']) assert.ok(messages[0].data.includes(part), part)
  })

  it('a request cannot add a recipient', async () => {
    const cfg = config()
    const service = new ActivationService({ db: openDatabase(':memory:'), config: cfg, mailer: createSmtpMailer(cfg) })
    await service.requestOtp({ activationId: A, deviceKey: 'a'.repeat(64), plan: 'monthly', ip: '127.0.0.1', to: 'customer@example.com', email: 'customer@example.com' })
    assert.deepEqual(messages[0].to, ['admin@example.com'])
  })

  it('the test email reports the recipient and carries no OTP', async () => {
    const { accepted } = await createSmtpMailer(config()).sendTest()
    assert.deepEqual(accepted, ['admin@example.com'])
    assert.ok(!/\b\d{6}\b/.test(messages[0].data.split('\n\n').slice(1).join()))
  })
})

describe('administrator email setting', () => {
  it('accepts exactly one address', () => {
    assert.ok(isEmailAddress('admin@example.com'))
    for (const bad of ['', 'nope', 'a@b', 'a@example.com,b@example.com', 'a@example.com b@example.com', 'Name <a@example.com>', 'a@example.com;b@example.com']) assert.ok(!isEmailAddress(bad), bad)
  })

  it('refuses to start with more than one address configured', () => {
    assert.throws(() => loadConfig({ ADMIN_EMAIL: 'a@example.com,b@example.com' }), /one email address/)
  })

  it('changes only that line of the settings file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xauto-env-'))
    const file = join(dir, '.env')
    writeFileSync(file, 'SMTP_PASS=a$&b\nADMIN_EMAIL=old@example.com\nPORT=8787\n')
    setAdminEmail(file, 'new$&@example.com')
    assert.equal(readFileSync(file, 'utf8'), 'SMTP_PASS=a$&b\nADMIN_EMAIL=new$&@example.com\nPORT=8787\n')
    assert.throws(() => setAdminEmail(file, 'a@example.com,b@example.com'))
    assert.ok(readFileSync(file, 'utf8').includes('new$&@example.com'))
    rmSync(dir, { recursive: true })
  })
})

describe('staging reset', () => {
  it('works only on staging', async () => {
    const cfg = config()
    const service = new ActivationService({ db: openDatabase(':memory:'), config: cfg, mailer: { sendOtp: async () => {} } })
    assert.throws(() => service.resetForTesting(A), /STAGING/)
    cfg.staging = true
    await service.requestOtp({ activationId: A, deviceKey: 'a'.repeat(64), plan: 'monthly', ip: '127.0.0.1' })
    service.resetForTesting(A)
    assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM otps').get().n, 0)
    assert.equal(service.db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%:device:%'").get().n, 0)
    assert.equal((await service.requestOtp({ activationId: A, deviceKey: 'a'.repeat(64), plan: 'monthly', ip: '127.0.0.1' })).expiresAt.length > 0, true)
  })
})
