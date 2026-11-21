import 'server-only'
import { createHash } from 'node:crypto'
import { pool } from '@/lib/db'
import { withBasePath } from '@/lib/base-path'
import { deliverMail, mailConfigured, type MailMessage } from '@/lib/mail-delivery'
import type { OrganizationInvitationOutcome } from './organization-invitations'

/** Existing auth mail credentials alone must not opt a deployment into invitation mail costs. */
export function organizationInvitationMailEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MIKKA_ORG_INVITE_EMAIL_ENABLED === 'true' && mailConfigured(env)
}

/** The configured app origin is authoritative; never use the request Host for bearer links. */
export function organizationInvitationMail(
  invite: Extract<OrganizationInvitationOutcome, { created: true }>,
  origin: string,
): MailMessage {
  const base = new URL(origin)
  if (base.origin !== origin || base.username || base.password
    || (base.protocol !== 'https:' && !(base.protocol === 'http:'
      && (base.hostname === 'localhost' || base.hostname === '127.0.0.1')))) {
    throw new Error('invalid_organization_invitation_origin')
  }
  if (!/^\/organization-invite\/[a-f0-9]{64}$/.test(invite.path)) {
    throw new Error('invalid_organization_invitation_path')
  }
  const url = base.origin + withBasePath(invite.path)
  const idempotencyKey = 'mikka-org-invite-' + createHash('sha256')
    .update(invite.id + '\0' + invite.path).digest('hex')
  return {
    to: invite.email,
    subject: 'Invitation to join a Mikka organization',
    text: [
      'You have been invited to join an organization in Mikka as a Member.',
      '',
      url,
      '',
      'The invitation expires in 7 days. It does not grant access to private Workspaces or Projects.',
      'If you did not expect this invitation, ignore this email.',
    ].join('\n'),
    idempotencyKey,
  }
}

async function optedOutInvitationRecipients(emails: string[]): Promise<Set<string>> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT lower(u.email) AS email FROM user_preferences p
       JOIN "user" u ON u.id = p."userId"
      WHERE NOT p."organizationInvitationEmails" AND u."emailVerified" AND lower(u.email) = ANY($1::text[])`,
    [emails],
  )
  return new Set(rows.map(row => row.email))
}

/** Provider acceptance only, not mailbox delivery. Never return bearer links in logs or errors. */
export async function sendOrganizationInvitationEmails(
  outcomes: OrganizationInvitationOutcome[],
  origin: string,
  deliver: (message: MailMessage) => Promise<void> = deliverMail,
  optedOut: (emails: string[]) => Promise<Set<string>> = optedOutInvitationRecipients,
): Promise<{ acceptedByProvider: number; failed: number }> {
  const created = outcomes.filter(
    (outcome): outcome is Extract<OrganizationInvitationOutcome, { created: true }> => outcome.created,
  )
  if (!created.length) return { acceptedByProvider: 0, failed: 0 }
  // Address ownership and the recipient’s preference must both be current at delivery.
  const suppressed = await optedOut(created.map(invite => invite.email))
  const messages = created.filter(invite => !suppressed.has(invite.email)).map(invite => organizationInvitationMail(invite, origin))
  let next = 0, acceptedByProvider = 0, failed = 0
  // Bound provider concurrency for multi-address invites; request execution has already committed.
  const worker = async () => {
    for (;;) {
      const position = next++
      if (position >= messages.length) return
      try {
        await deliver(messages[position])
        acceptedByProvider++
      } catch {
        // The underlying provider may include recipient addresses, tokens or credentials in errors.
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, messages.length) }, worker))
  return { acceptedByProvider, failed }
}
