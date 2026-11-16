import assert from 'node:assert/strict'

/** The signed-in renderer uses the same organization endpoints as the Settings screen. */
export async function verifyOrganizationLifecycle({ page, workspaceId, passed, setPhase }) {
  const request = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const response = await fetch('/mikka/api/organizations' + path, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, data: await response.json() }
  }, { path, method, body })

  setPhase('organization_create_rename_and_attach_workspace')
  const created = await request('', 'POST', { name: 'Desktop organization' })
  assert.equal(created.status, 200)
  assert.equal(created.data.role, 'owner')
  const path = '/' + created.data.id
  const workspaces = path + '/workspaces'
  const renamed = await request(path, 'PATCH', { name: 'Renamed on Desktop' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.data.organization.name, 'Renamed on Desktop')
  assert.equal((await request(workspaces, 'POST', { workspaceId })).data.attached, true)
  assert.deepEqual((await request(path)).data.workspaceIds, [workspaceId])
  passed('packaged_owner_creates_renames_and_binds_current_team_workspace')

  setPhase('organization_read_audit_and_explicit_export')
  const audit = path + '/audit-log'
  const listed = await request(audit + '?view=events&limit=1')
  assert.equal(listed.status, 200)
  assert.equal(listed.data.events.length, 1)
  const exported = await request(audit, 'POST', {})
  assert.equal(exported.status, 200)
  assert.equal(exported.data.manifest.organizationId, created.data.id)
  const frozen = await request(audit + '?exportId=' + exported.data.manifest.id + '&limit=1')
  assert.equal(frozen.status, 200)
  assert.equal(frozen.data.manifest.digest, exported.data.manifest.digest)
  assert.equal(frozen.data.events.length, 1)
  passed('packaged_organization_owner_reads_live_audit_and_frozen_export')

  setPhase('organization_detach_and_archive')
  const blocked = await request(path, 'DELETE')
  assert.equal(blocked.status, 409)
  assert.equal(blocked.data.error.detail, 'workspace_attached')
  assert.equal((await request(workspaces, 'DELETE', { workspaceId })).data.detached, true)
  assert.equal((await request(path, 'DELETE')).data.archived, true)
  const archived = await request('?archived=true')
  assert.equal(archived.status, 200)
  assert.ok(archived.data.organizations.some(row => row.id === created.data.id))
  passed('packaged_owner_detaches_archives_and_reads_archived_organization')
}

/** Run this while the independently authenticated recipient is using the installed client. */
export async function acceptReceivedOrganizationInvitation(page, invitation, passed) {
  const result = await page.evaluate(async ({ id }) => {
    const inbox = await fetch('/mikka/api/me/invitations')
    const visible = (await inbox.json()).invitations.some(row => row.id === id)
    if (!visible) return { visible: false }
    const response = await fetch('/mikka/api/organization-invitations/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invitationId: id }),
    })
    const accepted = await response.json()
    const after = await fetch('/mikka/api/me/invitations')
    return { visible, status: response.status, organizationId: accepted.organizationId, joined: accepted.joined,
      role: accepted.role, removed: !(await after.json()).invitations.some(row => row.id === id) }
  }, invitation)
  assert.deepEqual(result, { visible: true, status: 200, organizationId: invitation.organizationId, joined: true, role: 'member', removed: true })
  passed('packaged_verified_recipient_accepts_received_organization_mail_invitation_as_member')
}
