import assert from 'node:assert/strict'

/** The guarded Compose driver supplies its signed-in first account and Mailpit event reader. */
export async function prepareOrganizationInvitation(request, nextMail, recipient, origin) {
  const organization = await (await request('/mikka/api/organizations', {
    method: 'POST', body: { name: 'Installed Desktop invitation' },
  })).json()
  assert.equal(organization.role, 'owner')
  const path = '/mikka/api/organizations/' + organization.id + '/invitations'
  const issue = async () => (await (await request(path, { method: 'POST', body: { emails: [recipient] } })).json()).outcomes[0]
  const invitation = await issue()
  assert.equal(invitation.created, true)
  const link = await nextMail('Invitation to join a Mikka organization', recipient)
  assert.equal(link.origin === origin && link.pathname === '/mikka' + invitation.path && !link.search && !link.hash, true)
  assert.equal(/^\/mikka\/organization-invite\/[a-f0-9]{64}$/.test(link.pathname), true)
  const replay = await issue()
  assert.equal(replay.created === false && replay.reason === 'pending', true)
  return { id: invitation.id, organizationId: organization.id }
}
