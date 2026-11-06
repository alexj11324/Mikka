/** One-off, explicitly authorized #1503 setup. Does not execute or forge Factory evidence. */
import { mkdir, writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { smokeSession, SMOKE_ID, OWNER_ID, fail } from './http'
import { pool } from '../../../lib/db'
import { workspaceDb, workspacePool } from '../../../lib/workspace-db'
import { workspaces, workspaceMembers } from '../../../lib/db/workspace-schema'
import { requireWorkspace } from '../../../lib/workspace-access'
import { getSubscriptionShare, setOwnSubscriptionShare } from '../../../lib/personal-policy-server'
import { enqueueWorkspaceAudit } from '../../../lib/audit/delivery'
import { ownerWorkspaceListsChanged, workspaceListChanged } from '../../../lib/live/lists'

const report: Record<string, any> = { issue: 1503, phase: 'preflight', startedAt: new Date().toISOString(), status: 'running' }
let session: Awaited<ReturnType<typeof smokeSession>> | undefined
try {
  report.stage = 'normal_smoke_login'
  session = await smokeSession()
  report.smokeUserId = session.user.id
  report.productionBuild = (await session.json('/api/version')).build
  console.log(JSON.stringify({ phase: 'normal_smoke_sign_in', userId: report.smokeUserId, build: report.productionBuild }))
  const slug = 'issue-1503-factory-smoke-20261106'
  report.stage = 'dedicated_workspace'
  const existing = await workspaceDb.select({ id: workspaces.id, userId: workspaces.userId, kind: workspaces.kind })
    .from(workspaces).where(eq(workspaces.slug, slug)).limit(1)
  if (existing[0] && (existing[0].userId !== SMOKE_ID || existing[0].kind !== 'team')) fail('fixture_workspace_mismatch')
  const workspaceId: string = existing[0]?.id ?? (await session.rpc('workspace.createWorkspace', [{ name: 'Issue 1503 Factory 生产验收', slug }])).data.workspaceId
  report.workspaceId = workspaceId
  // The user authorized production account/resource configuration. Only this
  // dedicated two-person workspace is initialized; no user/auth/session row is fabricated.
  const owner = (await pool.query('SELECT id,name,email FROM "user" WHERE id=$1 AND email=$2', [OWNER_ID, 'alexjiang20232024@gmail.com'])).rows[0]
  if (!owner) fail('authorized_owner_missing')
  await workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, SMOKE_ID, true)
    const members = await tx.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
    if (members.some(member => ![SMOKE_ID, OWNER_ID].includes(member.userId) || member.status !== 'active')) fail('fixture_membership_changed')
    const already = members.find(member => member.userId === OWNER_ID)
    report.ownerMembershipCreated = !already
    if (!already) {
      await tx.insert(workspaceMembers).values({ workspaceId, userId: OWNER_ID, name: owner.name, email: owner.email, role: 'member' })
      await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'system', id: 'issue-1503-authorized-operator', name: 'Issue #1503 authorized setup' },
        action: 'member.joined', target: { type: 'member', id: OWNER_ID }, metadata: { role: 'member' } })
      await workspaceListChanged(tx, workspaceId, ['workspace_settings', 'issue_list'])
      await ownerWorkspaceListsChanged(tx, OWNER_ID, ['workspace_settings'])
    }
  })
  report.stage = 'subscription_share'
  const before = await getSubscriptionShare(OWNER_ID, workspaceId)
  report.shareBefore = { shared: before.shared, allowOthers: before.allowOthers, allowed: before.allowed }
  if (!before.allowed) fail('fixture_share_policy_denied')
  const after = await setOwnSubscriptionShare(OWNER_ID, workspaceId, { shared: true, allowOthers: true })
  report.shareAfter = { shared: after.shared, allowOthers: after.allowOthers, allowed: after.allowed }
  report.stage = 'numbered_team'
  const directory = await session.rpc('teams.loadTeamDirectory', [workspaceId])
  let team = directory.teams.find((item: any) => item.identifier === 'F1503')
  if (!team) team = (await session.rpc('teams.saveTeam', [{ workspaceId, name: 'Factory #1503 smoke', identifier: 'F1503', description: 'Issue #1503 production delivery acceptance; alexj11324/Mikka-handoff only.' }])).data
  report.teamId = team.id
  report.teamIdentifier = team.identifier
  const e2b = (await pool.query('SELECT "userId","verifiedAt","lastErrorCode" FROM user_e2b_keys WHERE "userId"=$1', [SMOKE_ID])).rows[0]
  report.e2bConfigured = Boolean(e2b)
  report.e2bChanged = false
  if (!e2b || e2b.lastErrorCode) fail('smoke_e2b_unavailable')
  report.stage = 'factory_catalog'
  const profiles = await session.json(`/api/factory/agent-profiles?workspaceId=${workspaceId}&location=cloud`)
  report.catalog = { keys: Object.keys(profiles.catalog ?? {}), models: (profiles.catalog?.models ?? []).filter((model: any) =>
    JSON.stringify(model).includes('claude-haiku-5-5') || JSON.stringify(model).includes('gpt-6-luna')) }
  report.existingProfiles = profiles.profiles?.map((profile: any) => ({ id: profile.id, version: profile.version, name: profile.definition?.name ?? profile.name }))
  report.stage = 'github_read'
  const github = await session.json('/api/integrations/github')
  report.github = { connected: github.connected, viewerId: github.viewerId, login: github.login, githubAccountId: github.githubAccountId,
    handoffAccessible: github.repositories?.some((repo: any) => repo.fullName === 'alexj11324/Mikka-handoff') ?? false }
  // GitHub operator initialization is a separate, provider-verified module.
  // This first receipt establishes normal login, membership and subscription visibility.
  report.status = 'ready_for_github_and_delivery'
} catch (error) {
  report.status = 'failed'
  report.code = error instanceof Error && /^issue1503_[a-z0-9_]+$/.test(error.message) ? error.message : 'issue1503_preflight_failed'
  report.errorType = error instanceof Error ? error.name : 'UnknownError'
  const causeCode = (error as any)?.code ?? (error as any)?.cause?.code
  if (typeof causeCode === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(causeCode)) report.causeCode = causeCode
  process.exitCode = 1
} finally {
  if (session) await session.close().catch(() => undefined)
  await Promise.allSettled([pool.end(), workspacePool.end()])
  report.completedAt = new Date().toISOString()
  await mkdir('issue1503-report', { recursive: true })
  await writeFile('issue1503-report/preflight.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
