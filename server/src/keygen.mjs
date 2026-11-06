// Prints a fresh signing key pair and OTP pepper. The private values go in the server's .env;
// the public key goes in src/shared/config/activation.ts of the desktop app.
import { generateKeyPairSync, randomBytes } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
console.log(`OTP_PEPPER=${randomBytes(32).toString('base64url')}`)
console.log(`SIGNING_PRIVATE_KEY=${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`)
console.log(`# Desktop app public key (not secret):`)
console.log(`# ${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`)
