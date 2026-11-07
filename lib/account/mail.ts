import 'server-only'
import { deliverMail, mailConfigured, type MailOptions } from '@/lib/mail-delivery'

// Account mail goes through the same provider and sender as sign-in mail
// (lib/mail-delivery.ts: SMTP first, then Resend). Unlike sign-in mail it is sent
// in the foreground: the person is told it was sent only once the provider accepted it.

export type AccountMailOutcome = 'sent' | 'unavailable' | 'failed'

export function accountMailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return mailConfigured(env)
}

export async function sendAccountMail(
  message: { to: string; subject: string; text: string },
  options: MailOptions = {},
): Promise<AccountMailOutcome> {
  const env = options.env ?? process.env
  if (!mailConfigured(env, options.apiKey ?? env.RESEND_API_KEY)) return 'unavailable'
  try {
    await deliverMail(message, options)
    return 'sent'
  } catch {
    // Never log recipients, links or provider bodies.
    console.error('account_email_delivery_failed')
    return 'failed'
  }
}
