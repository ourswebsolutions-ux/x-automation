// The small part of nodemailer the app uses (the package ships no types).
declare module 'nodemailer' {
  interface SendMailOptions {
    from: string
    to: string
    subject: string
    text: string
    html?: string
  }
  interface SentMessageInfo {
    accepted: string[]
    rejected: string[]
  }
  interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>
  }
  interface TransportOptions {
    host: string
    port: number
    secure: boolean
    auth: { user: string; pass: string }
    tls?: { minVersion?: string }
    connectionTimeout?: number
    socketTimeout?: number
  }
  const nodemailer: { createTransport(options: TransportOptions): Transporter }
  export default nodemailer
}
