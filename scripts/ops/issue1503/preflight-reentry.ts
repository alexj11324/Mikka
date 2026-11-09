/** Explicit #1503 reentry setup. Existing workspace/team; new scoped GitHub child; no delivery actions. */
import { mkdir, writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { smokeSession, SMOKE_ID, OWNER_ID, fail } from './http'
import { pool } from '../../../lib/db'
import { workspaceDb, workspacePool } from '../../../lib/workspace-db'
import { workspaces, workspaceMembers } from '../../../lib/db/workspace-schema'
import { requireWorkspace } from '../../../lib/workspace-access'
import { getSubscriptionShare, setOwnSubscriptionShare } from '../../../lib/personal-policy-server'
import { setupIssue1503SmokeGitHub } from '../issue1503-smoke-github.mjs'
import { REENTRY, reentryRuntime, reentryE2bObservation } from './reentry-fixture.mjs'

const report: Record<string, any> = { issue: 1503, phase: 'preflight_reentry', ownerUserId: OWNER_ID, startedAt: new Date().toISOString(), status: 'running' }
let session: Awaited<ReturnType<typeof smokeSession>> | undefined
try {
  const runtime = reentryRuntime(process.env)
  report.operatorSha = runtime.operatorSha; report.marker = runtime.marker
  report.stage = 'normal_smoke_login'
  session = await smokeSession()
  report.smokeUserId = session.user.id
  report.productionBuild = (await session.json('/api/version')).build
  if (report.smokeUserId !== SMOKE_ID || report.productionBuild !== runtime.expectedAppSha) fail('reentry_deployment_or_user_changed')
  console.log(JSON.stringify({ phase: 'normal_smoke_sign_in', userId: report.smokeUserId, build: report.productionBuild }))
  const slug = 'issue-1503-factory-smoke-20261106'
  report.stage = 'dedicated_workspace'
  const existing = await workspaceDb.select({ id: workspaces.id, userId: workspaces.userId, kind: workspaces.kind })
    .from(workspaces).where(eq(workspaces.slug, slug)).limit(1)
  if (!existing[0] || existing[0].id !== REENTRY.workspaceId || existing[0].userId !== SMOKE_ID || existing[0].kind !== 'team') fail('reentry_workspace_mismatch')
  const workspaceId: string = existing[0].id
  report.workspaceId = workspaceId
  // The user authorized production account/resource configuration. Only this
  // dedicated two-person workspace is initialized; no user/auth/session row is fabricated.
  const owner = (await pool.query('SELECT id,name,email FROM "user" WHERE id=$1 AND email=$2', [OWNER_ID, 'alexjiang20232024@gmail.com'])).rows[0]
  if (!owner) fail('authorized_owner_missing')
  await workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, SMOKE_ID, true)
    const members = await tx.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
    if (members.some(member => ![SMOKE_ID, OWNER_ID].includes(member.userId) || member.status !== 'active')) fail('fixture_membership_changed')
    if (members.length !== 2 || !members.some(member => member.userId === OWNER_ID)
      || !members.some(member => member.userId === SMOKE_ID)) fail('reentry_membership_changed')
    report.ownerMembershipCreated = false
  })
  report.stage = 'subscription_share'
  const before = await getSubscriptionShare(OWNER_ID, workspaceId)
  report.shareBefore = { shared: before.shared, allowOthers: before.allowOthers, allowed: before.allowed }
  if (!before.allowed || before.shared || before.allowOthers) fail('reentry_share_original_changed')
  const after = await setOwnSubscriptionShare(OWNER_ID, workspaceId, { shared: true, allowOthers: true })
  report.shareAfter = { shared: after.shared, allowOthers: after.allowOthers, allowed: after.allowed }
  if (!after.shared || !after.allowOthers || !after.allowed) fail('reentry_share_readback_changed')
  report.stage = 'numbered_team'
  const directory = await session.rpc('teams.loadTeamDirectory', [workspaceId])
  const team = directory.teams.find((item: any) => item.identifier === 'F1503')
  if (!team || team.id !== REENTRY.teamId) fail('reentry_team_mismatch')
  report.teamId = team.id
  report.teamIdentifier = team.identifier
  let e2b = (await pool.query('SELECT "userId","verifiedAt","lastErrorCode","updatedAt","updatedAt"::text AS "updatedAtText", "updatedAt"=$2::timestamptz AS "retainedInstallationMatches" FROM user_e2b_keys WHERE "userId"=$1', [SMOKE_ID, REENTRY.retainedE2bUpdatedAt])).rows[0]
  report.e2bConfigured = Boolean(e2b)
  report.e2bChanged = false
  if (!e2b) {
    report.stage = 'authorized_e2b_setup'
    const { getUserE2BApiKey } = await import('../../../lib/secrets/e2b')
    // The same Alex owns this tagged smoke alias. Configure it through the
    // normal write-only API, including E2B's live key check and normal sealing.
    // The secret remains in this runner's memory and is never reported.
    await session.rpc('workspace-secrets.saveE2BKey', [{ apiKey: await getUserE2BApiKey(OWNER_ID) }, workspaceId])
    e2b = (await pool.query('SELECT "userId","verifiedAt","lastErrorCode","updatedAt","updatedAt"::text AS "updatedAtText", "updatedAt"=$2::timestamptz AS "retainedInstallationMatches" FROM user_e2b_keys WHERE "userId"=$1', [SMOKE_ID, REENTRY.retainedE2bUpdatedAt])).rows[0]
    report.e2bChanged = true
    report.e2bSetup = { userId: SMOKE_ID, updatedAt: e2b?.updatedAt?.toISOString() }
    report.e2bConfigured = Boolean(e2b)
  }
  if (!e2b || e2b.lastErrorCode) fail('smoke_e2b_unavailable')
  Object.assign(report, reentryE2bObservation(e2b, report.e2bChanged))
  report.stage = 'official_subscription_quota'
  for (const connectionId of ['93b6ab23-900b-4e18-9ea0-baccf2d104ce', 'ef66c1d8-2bbc-48e9-abf3-2ce3787ceef5']) {
    await session.rpc('model-order.checkModelOrderQuota', [connectionId, workspaceId])
  }
  report.stage = 'factory_catalog'
  const profiles = await session.json(`/api/factory/agent-profiles?workspaceId=${workspaceId}&location=cloud`)
  report.catalog = { keys: Object.keys(profiles.catalog ?? {}), models: (profiles.catalog?.models ?? []).filter((model: any) =>
    JSON.stringify(model).includes('claude-haiku-5-5') || JSON.stringify(model).includes('gpt-6-luna')) }
  report.existingProfiles = profiles.profiles?.map((profile: any) => ({ id: profile.id, version: profile.version, name: profile.definition?.name ?? profile.name }))
  report.stage = 'github_read'
  let github = await session.json('/api/integrations/github')
  if (github.connected) fail('reentry_github_connection_not_vacant')
  report.githubSetupCreated = true
  if (!github.connected) {
    report.stage = 'github_scoped_setup'
    report.githubSetup = (await setupIssue1503SmokeGitHub({ ownerUserId: OWNER_ID })).state
    github = await session.json('/api/integrations/github')
  }
  report.github = { connected: github.connected, viewerId: github.viewerId, login: github.login, githubAccountId: github.githubAccountId,
    handoffAccessible: github.repositories?.some((repo: any) => repo.fullName === 'alexj11324/Mikka-handoff') ?? false }
  if (!report.github.connected || report.github.viewerId !== SMOKE_ID || report.github.login !== 'alexj11324' || !report.github.handoffAccessible) fail('github_readback_mismatch')
  if ((await session.json('/api/version')).build !== runtime.expectedAppSha) fail('reentry_deployment_changed')
  report.status = 'prepared'
} catch (error) {
  report.status = 'failed'
  report.code = error instanceof Error && /^issue1503_[a-z0-9_]+$/.test(error.message) ? error.message : 'issue1503_preflight_failed'
  report.errorType = error instanceof Error ? error.name : 'UnknownError'
  const causeCode = (error as any)?.code ?? (error as any)?.cause?.code
  if (typeof causeCode === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(causeCode)) report.causeCode = causeCode
  if ((error as any)?.name === 'SmokeGitHubSetupError') report.githubFailure = (error as any).toJSON()
  process.exitCode = 1
} finally {
  if (session) await session.close().catch(() => undefined)
  await Promise.allSettled([pool.end(), workspacePool.end()])
  report.completedAt = new Date().toISOString()
  await mkdir('issue1503-report', { recursive: true })
  await writeFile('issue1503-report/preflight-reentry.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
