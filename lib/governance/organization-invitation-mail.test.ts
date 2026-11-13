import assert from 'node:assert/strict'
import test from 'node:test'
import { organizationInvitationMail, organizationInvitationMailEnabled, sendOrganizationInvitationEmails } from './organization-invitation-mail'
import type { OrganizationInvitationOutcome } from './organization-invitations'

function created(index: number): OrganizationInvitationOutcome {
  return {
    email: 'member' + index + '@example.invalid',
    created: true,
    id: '00000000-0000-4000-8000-' + String(index).padStart(12, '0'),
    path: '/organization-invite/' + index.toString(16).padStart(64, '0'),
  }
}

test('organization invitation mail uses only the configured trusted origin and a hashed idempotency key', () => {
  assert.equal(organizationInvitationMailEnabled({ RESEND_API_KEY: 'test' }), false)
  assert.equal(organizationInvitationMailEnabled({ MIKKA_ORG_INVITE_EMAIL_ENABLED: 'true' }), false)
  assert.equal(organizationInvitationMailEnabled({ MIKKA_ORG_INVITE_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test' }), true)
  const invite = created(1)
  if (!invite.created) throw new Error('bad fixture')
  const msg = organizationInvitationMail(invite, 'https://app.example.test')
  assert.equal(msg.to, invite.email)
  assert.match(msg.text, /^You have been invited/)
  assert.ok(msg.text.includes('https://app.example.test/'))
  assert.ok(msg.text.includes(invite.path))
  assert.equal(msg.idempotencyKey, organizationInvitationMail(invite, 'https://app.example.test').idempotencyKey)
  assert.doesNotMatch(msg.idempotencyKey ?? '', /00000000-0000|organization-invite/)
  assert.throws(() => organizationInvitationMail(invite, 'https://attacker.example.test/unsafe'), /invalid_organization_invitation_origin/)
  assert.throws(() => organizationInvitationMail(invite, 'http://attacker.example.test'), /invalid_organization_invitation_origin/)
  assert.throws(() => organizationInvitationMail({ ...invite, path: '//attacker.example.test' }, 'https://app.example.test'),
    /invalid_organization_invitation_path/)
})

test('only newly created links are sent; provider failures do not abort other recipients', async () => {
  const outcomes: OrganizationInvitationOutcome[] = [
    created(1), { email: 'duplicate@example.invalid', created: false, reason: 'pending' },
    created(2), created(3), created(4), created(5),
  ]
  let active = 0, maximum = 0
  const seen: string[] = []
  const result = await sendOrganizationInvitationEmails(outcomes, 'https://app.example.test', async message => {
    active++
    maximum = Math.max(maximum, active)
    seen.push(message.to)
    await Promise.resolve()
    active--
    if (message.to === 'member3@example.invalid') throw new Error('synthetic provider token should never leak')
  })
  assert.deepEqual(result, { acceptedByProvider: 4, failed: 1 })
  assert.deepEqual(seen.sort(), ['member1@example.invalid', 'member2@example.invalid', 'member3@example.invalid',
    'member4@example.invalid', 'member5@example.invalid'])
  assert.equal(maximum, 2)
  assert.deepEqual(await sendOrganizationInvitationEmails([
    { email: 'pending@example.invalid', created: false, reason: 'pending' },
  ], 'https://app.example.test', async () => { throw new Error('not called') }), { acceptedByProvider: 0, failed: 0 })
})
