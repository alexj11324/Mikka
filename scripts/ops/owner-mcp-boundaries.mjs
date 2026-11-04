import { randomUUID } from 'node:crypto'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const FIXTURE_URL = 'https://example.com/mikka-owner-acceptance'
class OwnerMcpError extends Error { constructor(code) { super('owner_mcp_' + code); this.code = code } }
const check = (condition, code) => { if (!condition) throw new OwnerMcpError(code) }
const safeError = error => error instanceof OwnerMcpError ? error.message : 'owner_mcp_unconfirmed'

/**
 * Owner-only production HTTP management check. The parent runner owns the
 * fixed source/deployment, normal Smoke login/logout and canonical transport.
 * request returns a real Response and preserves the normal session cookies.
 */
export async function runOwnerMcpBoundaries({ owner, verifyTarget }) {
  check(typeof owner?.request === 'function' && typeof verifyTarget === 'function', 'normal_transport_required')
  const report = { schemaVersion: 1, status: 'failed', workspaceId: null, connectionId: null,
    counts: { ownedBots: null, before: null, withFixture: null, after: null },
    checks: { normalOwnerSession: false, personalWorkspace: false, existingBotsOwned: false,
      created: false, ownerMetadataReadback: false, personalShareRejected: false },
    http: { create: null, share: null, delete: null },
    cleanup: { deleteAttempted: false, deleteAcknowledged: false, absentReadback: false }, errors: [],
    coverage: { scope: 'single-owner-MCP-management', modelCalls: 0, providerCalls: 0,
      secretCreated: false, teamCreated: false, twoMemberSharing: false, gmail: false, frozenRunToken: false } }
  let ownerId, workspaceId, createdId
  const name = 'Owner MCP acceptance ' + randomUUID()
  const existing = new Set()
  async function request(path, method = 'GET', body) {
    const response = await owner.request(path, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const text = await response.text()
    check(Buffer.byteLength(text) <= 256 * 1024, 'body_limit')
    let data
    try { data = JSON.parse(text) } catch { throw new OwnerMcpError('response_shape') }
    return { status: response.status, data }
  }
  async function list() {
    const result = await request('/api/integrations/mcp?workspaceId=' + workspaceId)
    const page = result.data
    check(result.status === 200 && page?.workspaceId === workspaceId && page.workspaceKind === 'personal' && page.canShare === false
      && Array.isArray(page.servers) && page.count === page.servers.length, 'personal_catalog')
    check(page.servers.every(server => UUID.test(server.id ?? '') && server.ownerId === ownerId && server.mine === true), 'catalog_owner')
    return page
  }
  function ownFixture(server) {
    return server?.id === createdId && server.ownerId === ownerId && server.mine === true && server.name === name
      && server.url === FIXTURE_URL && server.transport === 'http' && server.enabled === false && server.authKind === 'none'
  }
  try {
    await verifyTarget()
    const session = await request('/api/auth/get-session')
    const user = session.data?.user
    check(session.status === 200 && typeof user?.id === 'string' && user.id
      && session.data.session?.userId === user.id
      && typeof user.email === 'string' && /^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(user.email), 'normal_smoke_session')
    ownerId = user.id; report.checks.normalOwnerSession = true
    const current = await request('/api/workspace')
    const context = current.data
    check(current.status === 200 && context?.currentUserId === ownerId && UUID.test(context.workspace?.id ?? '')
      && context.workspace.kind === 'personal' && context.role === 'admin'
      && Array.isArray(context.members) && context.members.length === 1
      && context.members[0].userId === ownerId && context.members[0].status === 'active', 'personal_owner_workspace')
    workspaceId = context.workspace.id; report.workspaceId = workspaceId; report.checks.personalWorkspace = true
    const bots = await request('/api/bots')
    check(bots.status === 200 && Array.isArray(bots.data) && bots.data.length > 0
      && bots.data.every(bot => UUID.test(bot.id ?? '') && bot.ownerId === ownerId && bot.workspaceId === workspaceId), 'existing_bot_owner')
    report.counts.ownedBots = bots.data.length; report.checks.existingBotsOwned = true
    const before = await list(); report.counts.before = before.count
    for (const server of before.servers) existing.add(server.id)
    const created = await request('/api/integrations/mcp', 'POST', { name, url: FIXTURE_URL, transport: 'http', enabled: false })
    report.http.create = created.status
    check(created.status === 201 && UUID.test(created.data?.server?.id ?? '') && !existing.has(created.data.server.id), 'new_connection_receipt')
    createdId = created.data.server.id; report.connectionId = createdId
    check(created.data.server.name === name && created.data.server.url === FIXTURE_URL && created.data.server.transport === 'http'
      && created.data.server.enabled === false && created.data.server.authKind === 'none', 'created_metadata')
    report.checks.created = true
    const page = await list(); report.counts.withFixture = page.count
    const observed = page.servers.find(server => server.id === createdId)
    check(ownFixture(observed) && observed.shared === false && Number.isInteger(observed.revision) && observed.revision > 0, 'owner_metadata')
    report.checks.ownerMetadataReadback = true
    const denied = await request('/api/integrations/mcp/shares', 'PATCH', { serverId: createdId, workspaceId, shared: true })
    report.http.share = denied.status
    // 504f: valid input in a personal workspace is workspaceAccessDenied/403.
    // A 400 is a malformed-input failure and cannot prove this boundary.
    check(denied.status === 403 && denied.data?.error === 'workspaceAccessDenied', 'personal_share_boundary')
    report.checks.personalShareRejected = true
  } catch (error) { report.errors.push(safeError(error)) }
  finally {
    if (createdId) {
      try {
        const page = await list()
        const target = page.servers.find(server => server.id === createdId)
        check(!existing.has(createdId) && ownFixture(target), 'cleanup_receipt_scope')
        report.cleanup.deleteAttempted = true
        const deleted = await request('/api/integrations/mcp', 'DELETE', { id: createdId })
        report.http.delete = deleted.status
        check(deleted.status === 200 && deleted.data?.deleted === true, 'delete_receipt')
        report.cleanup.deleteAcknowledged = true
      } catch (error) { report.errors.push(safeError(error)) }
      // An unknown DELETE outcome is only observed, never blindly retried.
      try {
        const after = await list(); report.counts.after = after.count
        report.cleanup.absentReadback = !after.servers.some(server => server.id === createdId)
        check(report.cleanup.absentReadback, 'cleanup_remaining')
      } catch (error) { report.errors.push(safeError(error)) }
    }
    try { await verifyTarget() } catch { report.errors.push('owner_mcp_deployment_changed') }
  }
  report.status = report.errors.length === 0 && Object.values(report.checks).every(Boolean)
    && report.cleanup.deleteAcknowledged && report.cleanup.absentReadback ? 'passed' : 'failed'
  return report
}
