// Activation backend, end to end over real HTTP with a real database. Only the clock and the SMTP
// transport are replaced, so each scenario exercises the code a customer's request actually reaches.
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { after, beforeEach, describe, it } from 'node:test'
import { ActivationService, OTP_COOLDOWN_MS, OTP_MAX_ATTEMPTS, OTP_TTL_MS, addMonths } from '../src/activation.mjs'
import { loadConfig, loadPlans } from '../src/config.mjs'
import { openDatabase } from '../src/db.mjs'
import { createApp } from '../src/http.mjs'
import { renderOtpEmail } from '../src/mailer.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const DAY = 86_400_000
const START = Date.UTC(2026, 0, 15, 12)
const A = 'XA-2345-6789-ABCD'
const B = 'XA-EFGH-JKLM-NPQR'
const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

const plans = loadPlans({ PLAN_CURRENCY: 'TST', PLAN_MONTHLY_PRICE: '10', PLAN_MONTHLY_DAYS: '30', PLAN_SIX_MONTHS_PRICE: '50', PLAN_LIFETIME_PRICE: '100' })

let clock, mail, service, server, base, db
const servers = []

async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
const request = (activationId = A, deviceKey = KEY_A, plan = 'monthly') => post('/v1/activation/request', { activationId, deviceKey, plan })
const confirm = (otp, activationId = A, deviceKey = KEY_A, plan = 'monthly') => post('/v1/activation/verify', { activationId, deviceKey, plan, otp })
const status = (activationId = A, deviceKey = KEY_A) => post('/v1/subscription/status', { activationId, deviceKey })
const lastOtp = () => mail.at(-1).otp
const wrong = (otp) => (otp === '000000' ? '000001' : '000000')

beforeEach(async () => {
  clock = START
  mail = []
  db = openDatabase(':memory:')
  const config = { plans, otpPepper: 'p'.repeat(32), privateKey, leaseMs: 7 * DAY }
  service = new ActivationService({ db, config, mailer: { sendOtp: async (d) => void mail.push(d) }, now: () => clock })
  server = createApp(service)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => servers.forEach((s) => s.close()))

describe('OTP issuing', () => {
  it('sends the administrator the ID, plan, price, OTP and expiry, and never returns the OTP', async () => {
    const { status: code, body } = await request()
    assert.equal(code, 200)
    assert.equal(body.expiresAt, new Date(START + OTP_TTL_MS).toISOString())
    assert.deepEqual(Object.keys(body), ['expiresAt'])
    assert.match(lastOtp(), /^\d{6}$/)
    const email = renderOtpEmail(mail.at(-1))
    for (const part of [A, 'Monthly', 'TST 10', lastOtp(), '2026-01-15 12:10:00 UTC']) assert.ok(email.text.includes(part), part)
  })

  it('stores only a keyed hash of the OTP', async () => {
    await request()
    const row = db.prepare('SELECT * FROM otps').get()
    assert.ok(!Object.values(row).includes(lastOtp()))
    assert.match(row.otp_hash, /^[0-9a-f]{64}$/)
  })

  it('accepts no recipient: a customer address in the request has no effect', async () => {
    await post('/v1/activation/request', { activationId: A, deviceKey: KEY_A, plan: 'monthly', email: 'customer@example.com', to: 'customer@example.com' })
    assert.deepEqual(Object.keys(mail[0]).sort(), ['activationId', 'expiresAt', 'otp', 'planName', 'priceLabel'])
  })

  it('refuses an unknown plan and malformed identities', async () => {
    assert.equal((await request(A, KEY_A, 'weekly')).body.error.code, 'plan_unavailable')
    assert.equal((await request('XA-0000-0000-0000')).status, 400)
    assert.equal((await request(A, 'short')).status, 400)
  })

  it('does not offer a plan whose price is not configured', async () => {
    const partial = loadPlans({ PLAN_CURRENCY: 'TST', PLAN_MONTHLY_PRICE: '10' })
    assert.deepEqual(partial.map((p) => p.id), ['monthly'])
    assert.deepEqual(loadPlans({}), [])
    assert.throws(() => loadPlans({ PLAN_MONTHLY_PRICE: 'ten', PLAN_CURRENCY: 'TST' }))
    assert.throws(() => loadPlans({ PLAN_MONTHLY_PRICE: '10' }))
  })

  it('publishes plans from configuration', async () => {
    const body = await (await fetch(`${base}/v1/plans`)).json()
    assert.deepEqual(body.plans.map((p) => [p.id, p.price, p.durationLabel]), [['monthly', '10', '30 days'], ['six_months', '50', '6 months'], ['lifetime', '100', 'Never expires']])
  })

  it('reports a failed email and leaves no usable code behind', async () => {
    service.mailer = { sendOtp: async () => { throw new Error('smtp down') } }
    const failed = await request()
    assert.equal(failed.status, 502)
    assert.equal(failed.body.error.code, 'email_failed')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM otps WHERE invalidated_at IS NULL').get().n, 0)
  })
})

describe('rate limiting', () => {
  it('enforces a cooldown between requests from one device', async () => {
    await request()
    assert.equal((await request()).body.error.code, 'cooldown')
    clock += OTP_COOLDOWN_MS
    assert.equal((await request()).status, 200)
  })

  it('limits requests per device per hour', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await request()).status, 200)
      clock += OTP_COOLDOWN_MS
    }
    assert.equal((await request()).body.error.code, 'rate_limited')
    clock += 3_600_000
    assert.equal((await request()).status, 200)
  })

  it('limits requests from one address across many devices', async () => {
    for (let i = 0; i < 10; i++) {
      const id = `XA-2222-2222-${'23456789ABCD'[i]}222`
      assert.equal((await request(id, KEY_A)).status, 200)
    }
    assert.equal((await request('XA-3333-3333-3333', KEY_A)).body.error.code, 'rate_limited')
  })

  it('limits verification attempts per device', async () => {
    await request()
    let last
    for (let i = 0; i < 16; i++) last = await confirm(wrong(lastOtp()))
    assert.equal(last.body.error.code, 'rate_limited')
  })
})

describe('OTP verification', () => {
  it('activates on the correct OTP and returns a signed token', async () => {
    await request()
    const { status: code, body } = await confirm(lastOtp())
    assert.equal(code, 200)
    assert.equal(body.state, 'active')
    assert.equal(body.plan, 'monthly')
    assert.equal(body.expiresAt, new Date(START + 30 * DAY).toISOString())
    const [payload, signature] = body.token.split('.')
    assert.ok(verify(null, Buffer.from(payload, 'base64url'), publicKey, Buffer.from(signature, 'base64url')))
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).activationId, A)
  })

  it('rejects an incorrect OTP', async () => {
    await request()
    const result = await confirm(wrong(lastOtp()))
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'otp_invalid')
    assert.equal((await status()).body.state, 'none')
  })

  it('accepts the OTP at 9:59 and rejects it at 10:00', async () => {
    await request()
    const otp = lastOtp()
    clock += OTP_TTL_MS - 1000
    await confirm(wrong(otp))
    clock += 999
    assert.equal((await confirm(otp)).status, 200)

    const other = await request(B, KEY_B)
    assert.equal(other.status, 200)
    clock += OTP_TTL_MS
    assert.equal((await confirm(lastOtp(), B, KEY_B)).body.error.code, 'otp_expired')
    assert.equal((await status(B, KEY_B)).body.state, 'none')
  })

  it('never accepts an OTP twice', async () => {
    await request()
    const otp = lastOtp()
    assert.equal((await confirm(otp)).status, 200)
    const expiry = (await status()).body.expiresAt
    const again = await confirm(otp)
    assert.equal(again.body.error.code, 'otp_used')
    assert.equal((await status()).body.expiresAt, expiry, 'reuse must not extend the subscription')
  })

  it('allows only one winner when the same OTP arrives concurrently', async () => {
    await request()
    const otp = lastOtp()
    const results = await Promise.all(Array.from({ length: 8 }, () => confirm(otp)))
    assert.equal(results.filter((r) => r.status === 200).length, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activation_logs WHERE event = 'activated'").get().n, 1)
  })

  it('rejects a valid OTP presented with another Activation ID', async () => {
    await request(A, KEY_A)
    const otp = lastOtp()
    const unknown = await confirm(otp, 'XA-2222-3333-4444', KEY_A)
    assert.equal(unknown.body.error.code, 'otp_invalid')
    assert.equal((await status('XA-2222-3333-4444', KEY_A)).body.state, 'none')
    // A second bound device with no code of its own gets nothing from device A's code either.
    await request(B, KEY_B)
    db.prepare('DELETE FROM otps WHERE activation_id = ?').run(B)
    assert.equal((await confirm(otp, B, KEY_B)).body.error.code, 'otp_invalid')
    assert.equal((await confirm(otp)).status, 200, 'the rightful device still activates')
  })

  it('rejects a valid OTP presented with another plan', async () => {
    await request(A, KEY_A, 'monthly')
    const otp = lastOtp()
    for (const plan of ['six_months', 'lifetime']) assert.equal((await confirm(otp, A, KEY_A, plan)).body.error.code, 'otp_invalid')
    assert.equal((await status()).body.state, 'none')
    const fine = await confirm(otp, A, KEY_A, 'monthly')
    assert.equal(fine.body.plan, 'monthly')
  })

  it('rejects the Activation ID when the device key differs (a copied ID is not enough)', async () => {
    await request(A, KEY_A)
    const stolen = await confirm(lastOtp(), A, KEY_B)
    assert.equal(stolen.status, 403)
    assert.equal(stolen.body.error.code, 'device_mismatch')
    assert.equal((await status(A, KEY_B)).body.error.code, 'device_mismatch')
    assert.equal((await request(A, KEY_B)).body.error.code, 'device_mismatch')
  })

  it('burns the OTP after too many wrong attempts, even if the right code follows', async () => {
    await request()
    const otp = lastOtp()
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) await confirm(wrong(otp))
    assert.equal((await confirm(otp)).body.error.code, 'otp_locked')
  })

  it('cancels the previous OTP when a new one is requested', async () => {
    await request()
    const first = lastOtp()
    clock += OTP_COOLDOWN_MS
    await request()
    if (first !== lastOtp()) assert.equal((await confirm(first)).body.error.code, 'otp_invalid')
    assert.equal((await confirm(lastOtp())).status, 200)
  })

  it('binds the OTP to its plan in the stored hash', async () => {
    await request()
    const { plan, otp_hash: hash } = db.prepare('SELECT plan, otp_hash FROM otps').get()
    assert.equal(plan, 'monthly')
    db.prepare("UPDATE otps SET plan = 'lifetime'").run()
    assert.equal((await confirm(lastOtp(), A, KEY_A, 'lifetime')).body.error.code, 'otp_invalid', 'editing the plan column cannot upgrade a code')
    assert.equal(db.prepare('SELECT otp_hash FROM otps').get().otp_hash, hash)
  })
})

describe('subscription lifetime', () => {
  const activate = async (plan, id = A, key = KEY_A) => {
    await request(id, key, plan)
    return confirm(lastOtp(), id, key, plan)
  }

  it('Monthly expires after the configured duration', async () => {
    await activate('monthly')
    clock += 30 * DAY - 1000
    assert.equal((await status()).body.state, 'active')
    clock += 1000
    const expired = await status()
    assert.equal(expired.body.state, 'expired')
    assert.equal(expired.body.token, null)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activation_logs WHERE event = 'expired'").get().n, 1)
  })

  it('6 Months expires six calendar months later', async () => {
    const { body } = await activate('six_months')
    assert.equal(body.expiresAt, new Date(Date.UTC(2026, 6, 15, 12)).toISOString())
    clock = Date.UTC(2026, 6, 15, 12)
    assert.equal((await status()).body.state, 'expired')
  })

  it('Month arithmetic keeps the end of the month', () => {
    assert.equal(new Date(addMonths(Date.UTC(2026, 7, 31), 6)).toISOString().slice(0, 10), '2027-02-28')
  })

  it('Lifetime never expires and its lease still renews', async () => {
    const { body } = await activate('lifetime')
    assert.equal(body.expiresAt, null)
    clock += 36_500 * DAY
    const later = await status()
    assert.equal(later.body.state, 'active')
    const claims = JSON.parse(Buffer.from(later.body.token.split('.')[0], 'base64url'))
    assert.equal(claims.leaseUntil, new Date(clock + 7 * DAY).toISOString())
    assert.equal((await request()).body.error.code, 'already_lifetime')
  })

  it('the lease is capped at the subscription expiry', async () => {
    await activate('monthly')
    clock += 29 * DAY
    const claims = JSON.parse(Buffer.from((await status()).body.token.split('.')[0], 'base64url'))
    assert.equal(claims.leaseUntil, new Date(START + 30 * DAY).toISOString())
  })

  it('renewing early keeps the remaining time; renewing late starts from today', async () => {
    await activate('monthly')
    clock += 10 * DAY
    assert.equal((await activate('monthly')).body.expiresAt, new Date(START + 60 * DAY).toISOString())
    clock = START + 90 * DAY
    assert.equal((await status()).body.state, 'expired')
    assert.equal((await activate('monthly')).body.expiresAt, new Date(clock + 30 * DAY).toISOString())
  })

  it('revocation takes effect at the next check and blocks renewal', async () => {
    await activate('lifetime')
    service.revoke(A, 'chargeback')
    const revoked = await status()
    assert.equal(revoked.body.state, 'revoked')
    assert.equal(revoked.body.token, null)
    assert.equal((await request()).body.error.code, 'revoked')
    assert.equal(service.reinstate(A), 'active')
    assert.equal((await status()).body.state, 'active')
  })

  it('an OTP issued before a revocation cannot activate after it', async () => {
    await activate('monthly')
    clock += OTP_COOLDOWN_MS
    await request()
    const otp = lastOtp()
    service.revoke(A)
    assert.equal((await confirm(otp)).body.error.code, 'revoked')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM otps WHERE used_at IS NOT NULL').get().n, 1, 'the code stays unused')
  })

  it('reinstalling on the same device restores the subscription without a new OTP', async () => {
    await activate('six_months')
    const restored = await status()
    assert.equal(restored.body.state, 'active')
    assert.ok(restored.body.token)
    assert.equal(mail.length, 1)
  })

  it('transfers to a replacement device: the old ID stops working, the new one continues', async () => {
    const { body } = await activate('six_months')
    await request(B, KEY_B, 'monthly')
    service.transfer(A, B)
    assert.equal((await status()).body.state, 'none')
    const moved = await status(B, KEY_B)
    assert.equal(moved.body.state, 'active')
    assert.equal(moved.body.expiresAt, body.expiresAt)
    await activate('monthly', 'XA-2222-3333-4444', KEY_A)
    assert.throws(() => service.transfer(B, 'XA-2222-3333-4444'), /already has/)
  })
})

describe('activation codes (no server on the customer side)', () => {
  const claimsOf = (code) => JSON.parse(Buffer.from(code.split('.')[0], 'base64url'))
  const valid = (code) => {
    const [payload, signature] = code.split('.')
    return verify(null, Buffer.from(payload, 'base64url'), publicKey, Buffer.from(signature, 'base64url'))
  }

  it('issues a signed code for the plan, lasting exactly as long as the plan', () => {
    const issued = service.issueCode(A, 'monthly')
    assert.equal(issued.expiresAt, new Date(START + 30 * DAY).toISOString())
    assert.ok(valid(issued.code))
    const claims = claimsOf(issued.code)
    assert.equal(claims.activationId, A)
    assert.equal(claims.plan, 'monthly')
    assert.equal(claims.leaseUntil, issued.expiresAt)
    assert.equal(mail.length, 0, 'no email is involved')
  })

  it('works with no prices configured at all', () => {
    service.config = { ...service.config, plans: [] }
    assert.equal(service.issueCode(A, 'six_months').expiresAt, new Date(Date.UTC(2026, 6, 15, 12)).toISOString())
  })

  it('Lifetime codes never lapse in practice', () => {
    const issued = service.issueCode(A, 'lifetime')
    assert.equal(issued.expiresAt, null)
    assert.equal(claimsOf(issued.code).leaseUntil, '2100-01-01T00:00:00.000Z')
  })

  it('issue renews like a payment; code repeats without adding time', () => {
    service.issueCode(A, 'monthly')
    clock += 10 * DAY
    assert.equal(service.issueCode(A, 'monthly').expiresAt, new Date(START + 60 * DAY).toISOString())
    assert.equal(service.issueCode(A, null, { renew: false }).expiresAt, new Date(START + 60 * DAY).toISOString())
    assert.equal(service.logs(A).map((l) => l.event).join(), 'code_reissued,code_issued,code_issued')
  })

  it('refuses unknown plans and IDs, a downgrade from Lifetime, and revoked devices', () => {
    assert.throws(() => service.issueCode(A, 'weekly'), /not available/)
    assert.throws(() => service.issueCode('XA-0000-0000-0000', 'monthly'), /Activation ID/)
    assert.throws(() => service.issueCode(B, null, { renew: false }), /No subscription/)
    service.issueCode(A, 'lifetime')
    assert.throws(() => service.issueCode(A, 'monthly'), /Lifetime/)
    assert.ok(valid(service.issueCode(A, 'lifetime').code), 'Lifetime can be given again')
    service.revoke(A)
    assert.throws(() => service.issueCode(A, 'lifetime'), /revoked/)
  })

  it('cannot reissue an expired subscription', () => {
    service.issueCode(A, 'monthly')
    clock += 31 * DAY
    assert.throws(() => service.issueCode(A, null, { renew: false }), /expired/)
    assert.equal(service.issueCode(A, 'monthly').expiresAt, new Date(clock + 30 * DAY).toISOString(), 'a new payment starts from today')
  })
})

describe('logs and transport', () => {
  it('records each step and never an OTP', async () => {
    await request()
    const otp = lastOtp()
    await confirm(wrong(otp))
    await confirm(otp)
    const events = service.logs(A).map((l) => l.event)
    assert.deepEqual(events, ['activated', 'verify_rejected', 'otp_requested'])
    assert.ok(!JSON.stringify(service.logs(A)).includes(otp))
  })

  it('refuses non-JSON and oversized bodies, and unknown routes', async () => {
    const text = await fetch(`${base}/v1/activation/request`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    assert.equal(text.status, 415)
    const big = await fetch(`${base}/v1/activation/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(5000) }) })
    assert.equal(big.status, 413)
    assert.equal((await fetch(`${base}/v1/admin`)).status, 404)
  })

  it('refuses to start with missing secrets', () => {
    assert.throws(() => loadConfig({}), /ADMIN_EMAIL/)
    assert.throws(() => loadConfig({ ADMIN_EMAIL: 'a@example.com' }), /OTP_PEPPER/)
    assert.throws(() => loadConfig({ ADMIN_EMAIL: 'a@example.com', OTP_PEPPER: 'short' }), /at least 32/)
  })
})
