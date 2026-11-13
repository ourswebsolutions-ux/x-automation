// Administrator console. Runs on the server against the database directly, so the HTTP API has no
// admin surface to attack.
import { loadRuntime, setAdminEmail } from './runtime.mjs'

const { config, envFile, service, mailer } = loadRuntime()
const [command, ...args] = process.argv.slice(2).filter((arg) => !arg.startsWith('--env='))
const date = (ms) => (ms === null ? 'never' : new Date(ms).toISOString())
const usage = `Usage: npm run admin -- <command>      (npm run admin:staging for the staging environment)
  issue <activationId> <plan>   activation code for a paid plan (monthly, six_months, lifetime);
                                adds the plan's time, like a renewal
  code <activationId>           the current subscription's code again, adding no time
  admin-email                   show where OTP emails go
  admin-email <address>         change it (restart the server afterwards)
  send-test                     send a test email to that address (it contains no OTP)
  smtp-check                    confirm the SMTP login works (sends nothing)
  list                          every subscription
  revoke <activationId> [why]   block a device
  reinstate <activationId>      undo a revocation
  transfer <oldId> <newId>      move a subscription to a replacement device
  logs [activationId]           recent activation events
  reset <activationId>          staging only: forget this device so the test can be repeated`

try {
  switch (command) {
    case 'issue':
    case 'code': {
      const issued = service.issueCode(args[0], args[1], { renew: command === 'issue' })
      console.log(`Plan: ${issued.plan}   Expires: ${issued.expiresAt ?? 'never'}`)
      console.log('Send the customer this activation code (all of it, one line):\n')
      console.log(issued.code)
      break
    }
    case 'admin-email':
      if (args[0]) {
        setAdminEmail(envFile, args[0])
        console.log(`OTP emails will go to ${args[0]}. Restart the server for this to take effect.`)
      } else console.log(`OTP emails go to ${config.adminEmail} (set in ${envFile})`)
      break
    case 'send-test': {
      const { accepted, rejected } = await mailer.sendTest()
      console.log(`SMTP server accepted: ${accepted.join(', ') || 'none'}. Rejected: ${rejected.join(', ') || 'none'}.`)
      console.log('Check that inbox, including Spam.')
      break
    }
    case 'smtp-check':
      await mailer.verify()
      console.log('SMTP login succeeded.')
      break
    case 'list':
      for (const s of service.listSubscriptions()) console.log(s.activation_id, s.plan.padEnd(10), s.status.padEnd(8), 'expires', date(s.expires_at), s.revoke_reason ?? '')
      break
    case 'revoke':
      service.revoke(args[0], args.slice(1).join(' '))
      console.log('Revoked. The device loses access at its next check (within 6 hours when online).')
      break
    case 'reinstate':
      console.log(`Reinstated: ${service.reinstate(args[0])}`)
      break
    case 'transfer':
      service.transfer(args[0], args[1])
      console.log('Transferred.')
      break
    case 'logs':
      for (const l of service.logs(args[0], 100)) console.log(date(l.at), l.event.padEnd(16), l.activation_id ?? '-', l.plan ?? '-', l.ip ?? '-', l.detail ?? '')
      break
    case 'reset':
      service.resetForTesting(args[0])
      console.log('Reset. In X Auto press Check now on the Subscription page.')
      break
    default:
      console.log(usage)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
