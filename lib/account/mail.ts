import 'server-only'
import { AUTH_EMAIL_FROM } from '@/lib/auth-email'

// Account mail goes through the same provider and sender as sign-in mail
// (lib/auth-email.ts: Resend, RESEND_API_KEY). Unlike sign-in mail it is sent
// in the foreground: the person is told it was sent only once Resend accepted it.

export type AccountMailOutcome = 'sent' | 'unavailable' | 'failed'

export function accountMailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.RESEND_API_KEY)
}

export async function sendAccountMail(
  message: { to: string; subject: string; text: string },
  options: { apiKey?: string; fetch?: typeof fetch } = {},
): Promise<AccountMailOutcome> {
  const key = options.apiKey ?? process.env.RESEND_API_KEY
  if (!key) return 'unavailable'
  try {
    const response = await (options.fetch ?? fetch)('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: AUTH_EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('delivery rejected') }
    const result: unknown = await response.json()
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || !result.id) throw new Error('delivery not accepted')
    return 'sent'
  } catch {
    // Never log recipients, links or provider bodies.
    console.error('account_email_delivery_failed')
    return 'failed'
  }
}
