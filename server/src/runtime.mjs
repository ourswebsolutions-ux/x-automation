import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ActivationService } from './activation.mjs'
import { isEmailAddress, loadConfig } from './config.mjs'
import { openDatabase } from './db.mjs'
import { createSmtpMailer } from './mailer.mjs'

/** `--env=.env.staging` selects another settings file; the default is `.env`. */
function envFileFromArgs(argv) {
  return argv.find((arg) => arg.startsWith('--env='))?.slice('--env='.length) ?? '.env'
}

/** Shared start-up for the server and the admin console. */
export function loadRuntime(argv = process.argv) {
  const envFile = envFileFromArgs(argv)
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  else if (envFile !== '.env') throw new Error(`${envFile} does not exist`)
  const config = loadConfig()
  const db = openDatabase(config.databasePath)
  const mailer = createSmtpMailer(config)
  return { config, db, envFile, mailer, service: new ActivationService({ db, config, mailer }) }
}

/** Changes the one recipient of OTP emails. Nothing else in the file is touched. */
export function setAdminEmail(envFile, address) {
  if (!isEmailAddress(address)) throw new Error('Give one email address, such as admin@example.com')
  const current = readFileSync(envFile, 'utf8')
  const line = /^ADMIN_EMAIL=.*$/m
  const next = line.test(current) ? current.replace(line, () => `ADMIN_EMAIL=${address}`) : `${current.trimEnd()}\nADMIN_EMAIL=${address}\n`
  const temp = `${envFile}.tmp`
  writeFileSync(temp, next, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, envFile)
  chmodSync(envFile, 0o600)
}
