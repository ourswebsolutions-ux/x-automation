# PIN and subscription

Two separate layers. Neither reads the other: `PinService` knows nothing of subscriptions,
`SubscriptionService` knows nothing of PINs, and only `AccessController` sees both.

| | PIN | Subscription |
| --- | --- | --- |
| Protects | Opening the app on this device | Paid features |
| Lives in | `<userData>/security/pin.json` | Activation server; a signed lease in `<userData>/security/subscription.json` |
| Works offline | Always | Until the lease ends (7 days by default) |

## What each state allows

Every IPC channel has a level in `src/shared/ipc/access.ts`, enforced in the main process before the
handler runs. The table is exhaustive, so **a new channel doesn't compile until it has a level**.

| Level | Needs | Examples |
| --- | --- | --- |
| `open` | Nothing | The lock screen's own calls, window controls |
| `unlocked` | PIN | Viewing data, settings, backups, stopping things, the Subscription page |
| `premium` | PIN and subscription | Creating, generating, publishing, campaigns, engine and browser profiles |

Stopping work is never premium: a customer whose subscription ended can still cancel a run. Renewal
and backups stay reachable for the same reason.

Background work has no IPC call to guard, so `AccessController.sync()` starts and stops it directly.
Scheduled publishing starts once both layers pass and stops when either ends. **Posts due during that
time are not published**; they become *missed*, as they do when the app is closed. This includes after
a reboot, because the app waits at the PIN screen.

Library images are refused while locked too.

## PIN

- Salted scrypt hashes only. The renderer never receives one.
- Five wrong attempts lock entry for 30 seconds, doubling up to 15 minutes. Counts are written before
  the answer is returned and survive restarts, and attempts run one at a time.
- A recovery code is shown once at setup. Using it sets a new PIN and issues a new code, and it shares
  the attempt limit. Without it a forgotten PIN can't be recovered.
- It is a separate file so that restoring a backup can't bring back an old PIN and "remove all stored
  keys" can't remove it.

This is an app lock, not disk encryption. Someone with access to the Windows account can read the
database directly or delete `pin.json`.

## Subscription

```
Activate → server emails the administrator the OTP → administrator checks payment
         → gives the customer the OTP → customer enters it → server activates → app gets a lease
```

- **Activation ID:** `XA-XXXX-XXXX-XXXX`, derived from the OS machine ID (Windows `MachineGuid`, macOS
  `IOPlatformUUID`, Linux `machine-id`), so a reinstall keeps it. A second value derived the same way,
  the device key, is never displayed and proves requests come from this device.
- **Lease:** an Ed25519-signed token, verified with the public key on every use. It lasts up to 7 days,
  never past the subscription's end, and renews every 6 hours while online. It can't be edited into an
  upgrade or copied to another device.
- **Reinstall:** the next check restores the subscription, with no OTP needed.
- **New PC:** a new Activation ID. The administrator runs `transfer`.
- **Wound-back clock:** detected by comparing the device with its own last-seen time. It deliberately
  does not compare with the server, so a PC with a wrong timezone can still activate. It lives in a
  plain file, so it raises the bar rather than being a guarantee.

Prices and durations exist only on the server (`server/README.md`). The app shows what `/v1/plans`
returns.

## Email OTP without a server

For use on your own PCs. Set these **Windows user environment variables** on each PC that runs X Auto
(System → About → Advanced system settings → Environment Variables → User variables), then start
X Auto again:

| Variable | Value |
| --- | --- |
| `XAUTO_SMTP_USER` | The email account that sends (for Gmail: the address) |
| `XAUTO_SMTP_PASS` | Its password (for Gmail: an app password) |
| `XAUTO_ADMIN_EMAIL` | The one address that receives OTPs |
| `XAUTO_SMTP_HOST`, `XAUTO_SMTP_PORT` | Optional; default `smtp.gmail.com`, `465` |
| `XAUTO_PLAN_CURRENCY`, `XAUTO_PRICE_MONTHLY`, `XAUTO_PRICE_SIX_MONTHS`, `XAUTO_PRICE_LIFETIME` | Optional; shown on the plans and in the email |
| `XAUTO_PLAN_MONTHLY_DAYS` | Optional; default 30 |

Or in PowerShell: `[Environment]::SetEnvironmentVariable('XAUTO_SMTP_PASS', '…', 'User')`.

When they are set and the build has no activation server, **Activate** emails a 6-digit OTP to
`XAUTO_ADMIN_EMAIL` from `XAUTO_SMTP_USER`; the administrator gives it to the user, who enters it.
The OTP expires after 10 minutes, works once, only for that Activation ID and plan, and five wrong
attempts burn it; one request a minute, five an hour. Only a salted HMAC of it is kept
(`security/otp.json`), and the activation is sealed in `security/subscription.json`.

The settings are read by the main process from the environment only: they are never in the app's
files, installer, window or logs. **The limits of having no server:** the SMTP password is on each PC
that sends, and the check runs on the same PC as the user, so whoever controls that PC can read the
password and get around the OTP. That is fine for your own PCs; for customers, use the server.

## Activation codes (no server)

A build without `XAUTO_ACTIVATION_URL` has no activation server. Its Subscription page offers **Copy
request** (Activation ID and plan, for the customer to send) and **Enter activation code**. The
administrator makes the code with `npm run admin -- issue <Activation ID> <plan>` (see
`server/README.md`). The code is a lease signed with the server's private key and lasting until the plan
ends, so `SubscriptionService.applyCode` checks it offline: genuine, for this Activation ID, not expired.
It can't be revoked. Builds with a server accept codes too. In development, `XAUTO_ACTIVATION_URL=none`
behaves like a build without one.

## Building

The server address is built in from `XAUTO_ACTIVATION_URL` and must be `https://`:

```bash
XAUTO_ACTIVATION_URL=https://activation.example.com npm run dist:win
```

**A build without it can never activate**, and every customer who installs it loses premium features
until they install a build that has it. The release workflow reads the `XAUTO_ACTIVATION_URL` repository
variable. If it is empty the run shows a warning and continues; if it isn't `https://` the run stops.
Development builds default to `http://127.0.0.1:8787`.

Environment overrides (`XAUTO_ACTIVATION_URL`, `XAUTO_ACTIVATION_PUBLIC_KEY`, `AXORA_TEST_SKIP_SECURITY`)
are ignored by installed builds.

## Before the first release with this system

Installed copies update themselves, so a release reaches every customer. Before releasing:

1. Set real prices in the production `server/.env`.
2. Host the server over https (`server/README.md`) and confirm `GET /healthz`.
3. Set the `XAUTO_ACTIVATION_URL` repository variable to that address.
4. Activate one test device against it.

## Tests

```bash
npm run test:server      # the backend, over real HTTP
npm run test:unit        # includes `security`: the app's side, against the real server code
npm run build && npm run test:security   # the real app, driven through its screens
```
