import assert from 'node:assert/strict'
import { expect } from '@playwright/test'

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

  setPhase('organization_default_resource_policy')
  const original = await request(path + '/policy')
  assert.equal(original.status, 200)
  const { modelCredentialSharing, mcpSharing, allowedModelProviders, auditRetentionDays, legalHold, revision } = original.data.policy
  assert.equal(revision, 0)
  const refused = await request(path + '/policy', 'PATCH', { modelCredentialSharing, mcpSharing, allowedModelProviders, auditRetentionDays, legalHold })
  assert.equal(refused.status, 409)
  assert.equal(refused.data.error.detail, 'feature_unavailable')
  assert.equal((await request(path + '/policy')).data.policy.revision, 0)
  passed('packaged_owner_reads_organization_resource_policy_and_community_refuses_paid_change')

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

/** The independently authenticated recipient accepts from installed Settings. Only the rendered control writes. */
export async function acceptReceivedOrganizationInvitation(page, invitation, revokedId, words, passed) {
  const settings = 'mikka://app/mikka/en/settings?section=organization'
  const matches = (response, path, method) => new URL(response.url()).pathname === '/mikka/api/' + path
    && response.request().method() === method
  async function openInbox() {
    const [response] = await Promise.all([
      page.waitForResponse(reply => matches(reply, 'me/invitations', 'GET')),
      page.goto(settings, { waitUntil: 'domcontentloaded' }),
    ])
    await expect(page).toHaveURL(settings)
    assert.equal(response.status(), 200)
    return (await response.json()).invitations
  }

  const inbox = await openInbox()
  assert.notEqual(revokedId, invitation.id)
  assert.equal(inbox.some(item => item.id === revokedId), false)
  assert.deepEqual(inbox.map(item => item.id), [invitation.id])
  await expect(page.getByText(words.invitations.receivedTitle, { exact: true })).toBeVisible()
  const name = page.getByText(inbox[0].organizationName, { exact: true })
  await expect(name).toBeVisible()
  // Domain discovery can show another Join on this page. Use the addressed invitation's row.
  const row = name.locator('xpath=ancestor::*[.//button][1]')
  const join = row.getByRole('button', { name: words.invitations.accept, exact: true })
    .or(row.getByRole('button', { name: words.domains.join, exact: true }))
  const [response] = await Promise.all([
    page.waitForResponse(reply => matches(reply, 'organization-invitations/accept', 'POST')),
    join.click(),
  ])
  const body = response.request().postDataJSON()
  assert.equal(Object.keys(body).length === 1 && body.invitationId === invitation.id, true)
  assert.equal(response.status(), 200)
  const accepted = await response.json()
  assert.equal(accepted.organizationId, invitation.organizationId)
  assert.equal(accepted.joined, true)
  assert.equal(accepted.role, 'member')
  assert.deepEqual(await openInbox(), [])
  passed('packaged_verified_recipient_accepts_received_organization_mail_invitation_as_member')
  passed('packaged_settings_join_click_sends_addressed_invitation_id_and_reopened_inbox_excludes_revoked_and_accepted')
}
