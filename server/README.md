# X Auto activation server

The backend for X Auto subscriptions. It issues OTPs, emails them to the administrator, keeps
subscription records and signs the leases the desktop app runs on. SMTP credentials, the OTP pepper,
the signing key and all prices live here and never in the desktop app.

It needs Node.js 22.13 or newer and one dependency (`nodemailer`). Data is a single SQLite file.

## Set up

```bash
cd server
npm ci
cp .env.example .env     # fill it in
npm run keys             # prints OTP_PEPPER and SIGNING_PRIVATE_KEY for .env
npm start
```

Set the plan prices in `.env`. A plan with no price is not offered, and with no prices at all the app
shows "No plans are available yet".

| Setting | Meaning |
| --- | --- |
| `PLAN_CURRENCY` | Shown beside every price, for example `USD` or `PKR` |
| `PLAN_MONTHLY_PRICE`, `PLAN_MONTHLY_DAYS` | Monthly price and length in days (default 30) |
| `PLAN_SIX_MONTHS_PRICE` | 6 Months price. Runs six calendar months |
| `PLAN_LIFETIME_PRICE` | Lifetime price. Never expires |
| `LEASE_DAYS` | How long a device keeps working without reaching this server (default 7) |

**Back up `SIGNING_PRIVATE_KEY` and `data/activation.db`.** The app is built with the matching public
key: a new key pair means every customer needs an app update. The public key is in
`src/shared/config/activation.ts`.

## Administrator email

OTPs go to `ADMIN_EMAIL` in the server's settings file and nowhere else. The desktop app never knows
this address. To change it without touching source code:

```bash
npm run admin -- admin-email                    # show the current address
npm run admin -- admin-email you@example.com    # change it, then restart the server
npm run admin -- send-test                      # send a test email (it contains no OTP)
```

You can also edit the `ADMIN_EMAIL=` line by hand. Only one address is accepted. SMTP settings
(`SMTP_USER`, `SMTP_PASS`) are separate, so the sending account and the recipient can differ.

## Staging

Staging uses `.env.staging`, which has its own database (`data/staging.db`) and test prices, and sends
real email. Create it from `.env`: set `DATABASE_PATH=./data/staging.db`, set `PLAN_CURRENCY=TEST` with
small prices, and add `STAGING=1`. It is git-ignored.

From the project root, `npm run dev` starts this staging server along with the app (and stops it with
the app), unless one is already running. `npm run dev -- --server-only` starts just the server.

```bash
npm run start:staging
npm run admin:staging -- admin-email you@example.com   # then restart
npm run admin:staging -- reset XA-XXXX-XXXX-XXXX       # forget a device, to repeat a test
```

`reset` refuses to run without `STAGING=1`. A development build of X Auto connects to
`http://127.0.0.1:8787`, which is this server. An installed build ignores it.

## Deploy

Run it on any host that keeps a Node process and a disk (a small VPS is enough) behind HTTPS:

1. Put it behind a reverse proxy that terminates TLS, keep `HOST=127.0.0.1`, and set `TRUST_PROXY=1`
   so rate limits see real client addresses.
2. Copy `.env` to the server by hand. It is git-ignored and must stay that way.
3. Keep it running with systemd, pm2 or similar.
4. Set `XAUTO_ACTIVATION_URL` to the public `https://` address when building the app (see
   `docs/security.md`). `GET /healthz` confirms it is up.

## Daily use

1. A customer clicks **Activate**. You receive an email with the Activation ID, plan, price, OTP and
   expiry.
2. Check their payment.
3. Send them the OTP yourself by WhatsApp, phone or similar, within 10 minutes. If it lapses they
   request another.

From the server:

```bash
npm run admin -- list                         # every subscription
npm run admin -- revoke XA-XXXX-XXXX-XXXX why # block a device
npm run admin -- reinstate XA-XXXX-XXXX-XXXX  # undo a revocation
npm run admin -- transfer OLD-ID NEW-ID       # customer replaced their PC
npm run admin -- logs [XA-XXXX-XXXX-XXXX]     # activation history
npm run admin -- smtp-check                   # test the SMTP login, sends nothing
npm run admin -- send-test                    # send a test email to the administrator
```

There is deliberately no admin web interface: these commands work on the database directly, so the
public API has nothing to attack. A revocation reaches an online device within 6 hours (at once if the
customer presses **Check now**) and an offline one when its lease ends.

## API

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Liveness |
| `GET /v1/plans` | Plans and prices |
| `POST /v1/activation/request` | `{activationId, deviceKey, plan}`: creates an OTP and emails the administrator |
| `POST /v1/activation/verify` | `{activationId, deviceKey, plan, otp}`: activates |
| `POST /v1/subscription/status` | `{activationId, deviceKey}`: state and a renewed lease |

## Rules it enforces

- An OTP is 6 random digits, expires after 10 minutes and works once. It is stored only as an HMAC
  that covers the Activation ID and plan, so it can't be read back or moved to another device or plan.
- A new request cancels the previous OTP. Five wrong attempts burn it. A failed email leaves no
  usable code.
- Limits per device, per address and overall are kept in the database, so a restart doesn't clear them:
  one request per minute per device, 5 per hour per device, 10 per hour per address, 100 per hour
  overall, 15 checks per 10 minutes per device.
- The recipient is fixed to `ADMIN_EMAIL` inside the mailer. No request can name one.
- The first request ties an Activation ID to its device key, so knowing an ID is not enough.
- Every step goes in `activation_logs`. OTPs never do.

## Tests

```bash
npm test
```
