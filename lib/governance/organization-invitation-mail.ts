import 'server-only'
import { createHash } from 'node:crypto'
import { withBasePath } from '@/lib/base-path'
import { deliverMail, type MailMessage } from '@/lib/mail-delivery'
import type { OrganizationInvitationOutcome } from './organization-invitations'

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

/** Provider acceptance only, not mailbox delivery. Never return bearer links in logs or errors. */
export async function sendOrganizationInvitationEmails(
  outcomes: OrganizationInvitationOutcome[],
  origin: string,
  deliver: (message: MailMessage) => Promise<void> = deliverMail,
): Promise<{ acceptedByProvider: number; failed: number }> {
  const messages = outcomes.filter(
    (outcome): outcome is Extract<OrganizationInvitationOutcome, { created: true }> => outcome.created,
  ).map(outcome => organizationInvitationMail(outcome, origin))
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
