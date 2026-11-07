import { createHash } from 'node:crypto'

type Env = Record<string, string | undefined>
export type MailMessage = { to: string; subject: string; text: string; idempotencyKey?: string }
export type MailOptions = { env?: Env; apiKey?: string; fetch?: typeof fetch }

export function mailFrom(env: Env = process.env): string {
  return env.MIKKA_EMAIL_FROM?.trim() || 'Mikka <noreply@aspectlylabs.com>'
}
export function mailConfigured(env: Env = process.env, apiKey = env.RESEND_API_KEY): boolean {
  return Boolean(env.SMTP_URL?.trim() || apiKey)
}

/** One delivery boundary for authentication, account and operator mail.
 * Provider errors never expose recipients, authentication links or credentials. */
export async function deliverMail(message: MailMessage, options: MailOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const from = mailFrom(env), smtpUrl = env.SMTP_URL?.trim()
  try {
    if ([from, message.to, message.subject].some(value => /[\r\n\0]/.test(value))) throw new Error()
    if (smtpUrl) {
      const url = new URL(smtpUrl)
      if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error()
      const { createTransport } = await import('nodemailer')
      const transport = createTransport({ url: smtpUrl, logger: false, debug: false, transactionLog: false,
        disableFileAccess: true, disableUrlAccess: true, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 })
      try {
        const result = await transport.sendMail({ from, to: [{ address: message.to, name: '' }], subject: message.subject, text: message.text,
          ...(message.idempotencyKey ? { messageId: `<${createHash('sha256').update(message.idempotencyKey).digest('hex')}@mikka.local>` } : {}) })
        if (!result.accepted?.length || result.rejected?.length) throw new Error()
      } finally { transport.close() }
      return
    }
    const apiKey = options.apiKey ?? env.RESEND_API_KEY
    if (!apiKey) throw new Error()
    const response = await (options.fetch ?? fetch)('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
        ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey } : {}) },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error() }
    const result: unknown = await response.json()
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || !result.id) throw new Error()
  // error-cause: mail provider errors can contain SMTP credentials, recipients or reset links; preserve only the fixed delivery code.
  } catch { throw new Error('mail_delivery_unavailable') }
}
