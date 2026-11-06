import nodemailer from 'nodemailer'

function htmlEscape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function renderOtpEmail({ activationId, planName, priceLabel, otp, expiresAt }) {
  const expiry = expiresAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const rows = [
    ['Activation ID', activationId],
    ['Plan', planName],
    ['Price', priceLabel],
    ['OTP', otp],
    ['Expires', `${expiry} (10 minutes after the request)`]
  ]
  const instruction = 'Verify the payment, then share this OTP with the customer yourself (WhatsApp, phone or similar). It works once, only for this Activation ID and plan.'
  return {
    subject: `X Auto activation request: ${activationId} (${planName})`,
    text: ['A customer asked to activate X Auto.', '', ...rows.map(([label, value]) => `${label}: ${value}`), '', instruction].join('\n'),
    html:
      '<p>A customer asked to activate X Auto.</p><table cellpadding="6">' +
      rows.map(([label, value]) => `<tr><td><b>${htmlEscape(label)}</b></td><td>${htmlEscape(value)}</td></tr>`).join('') +
      `</table><p>${htmlEscape(instruction)}</p>`
  }
}

/** The recipient is fixed here: no caller can direct an OTP anywhere but the administrator. */
export function createSmtpMailer(config) {
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15_000,
    socketTimeout: 20_000
  })
  return {
    sendOtp: (details) => transport.sendMail({ from: `"X Auto Activation" <${config.smtp.from}>`, to: config.adminEmail, ...renderOtpEmail(details) }),
    /** Confirms delivery settings. Carries no OTP. Returns what the SMTP server accepted. */
    sendTest: async () => {
      const { accepted, rejected } = await transport.sendMail({
        from: `"X Auto Activation" <${config.smtp.from}>`,
        to: config.adminEmail,
        subject: 'X Auto activation: test email',
        text: 'This address receives X Auto activation OTPs. No action is needed.'
      })
      return { accepted, rejected }
    },
    verify: () => transport.verify()
  }
}
