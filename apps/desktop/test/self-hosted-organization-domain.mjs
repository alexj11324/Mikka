import assert from 'node:assert/strict'

async function request(page, path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch('/mikka/api/' + path, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, data: await response.json() }
  }, { path, method, body })
}

export async function enableOrganizationDomain(page, email) {
  const created = await request(page, 'organizations', 'POST', { name: 'Desktop domain discovery' })
  assert.equal(created.status, 200)
  assert.equal(created.data.role, 'owner')
  const organizationId = created.data.id
  const path = 'organizations/' + organizationId + '/allowed-domains'
  const domain = email.split('@')[1]
  const added = await request(page, path, 'POST', { domain })
  assert.equal(added.status, 200)
  const listed = await request(page, path)
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.data.domains, [added.data.domain])
  assert.equal(added.data.domain.domain, domain)
  return { organizationId, domainId: added.data.domain.id }
}

/** A second invitation to the same recipient, using the existing domain fixture's organization. */
export async function prepareRevokedInvitation(page, organizationId, recipient) {
  const path = 'organizations/' + organizationId + '/invitations'
  // The issuer also returns a secret invitation link. Only the public invitation id leaves the renderer.
  const issued = await page.evaluate(async ({ path, recipient }) => {
    const response = await fetch('/mikka/api/' + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emails: [recipient] }),
    })
    const [outcome] = (await response.json()).outcomes ?? []
    return { status: response.status, created: outcome?.created === true, id: outcome?.id }
  }, { path, recipient })
  assert.equal(issued.status, 200)
  assert.equal(issued.created, true)
  assert.ok(typeof issued.id === 'string' && issued.id.length === 36)
  const revoked = await request(page, path, 'DELETE', { invitationId: issued.id })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.data.revoked, true)
  return issued.id
}

export async function joinDiscoveredOrganization(page, { organizationId }) {
  const discover = () => request(page, 'me/joinable-organizations')
  const before = await discover()
  assert.equal(before.status, 200)
  assert.ok(before.data.organizations.some(org => org.id === organizationId))
  const joined = await request(page, 'organizations/' + organizationId + '/join-by-domain', 'POST')
  assert.equal(joined.status, 200)
  assert.deepEqual(joined.data, { organizationId, joined: true, role: 'member' })
  const after = await discover()
  assert.equal(after.status, 200)
  assert.ok(!after.data.organizations.some(org => org.id === organizationId))
}

export async function removeOrganizationDomain(page, { organizationId, domainId }, userId) {
  const path = 'organizations/' + organizationId + '/allowed-domains'
  const removed = await request(page, path + '/' + domainId, 'DELETE')
  assert.equal(removed.status, 200)
  assert.equal(removed.data.removed, true)
  const listed = await request(page, path)
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.data.domains, [])
  const directory = await request(page, 'organizations/' + organizationId + '/members')
  assert.equal(directory.status, 200)
  assert.ok(directory.data.members.some(member => member.userId === userId && member.role === 'member' && member.status === 'active'))
}
