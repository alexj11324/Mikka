// Recovery only for the documented pre-dispatch CLI interruption in run
// 42418118236/job128547182838. No VM, task, shared credential or Bot is deleted.
import { createHash } from 'node:crypto'
import { auditTarget } from './auth-audit-production.mjs'
import { createSessionClient, smokeAcceptanceAccount } from './cloud-startup.mjs'
import { selectTeamWorkspace } from './team-workspace.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const RUN = '42418118236'
const START = Date.parse('2026-11-07T22:22:56.000Z'), END = Date.parse('2026-11-07T22:23:03.000Z')
const within = value => Date.parse(value) >= START && Date.parse(value) < END
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const check = (value, code) => { if (!value) throw Error(code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const codes = new Set(['scope_refused', 'identity_failed', 'fixture_ambiguous', 'fixture_changed', 'archive_failed', 'session_failed'])

/** Select in memory before any recovery write. The API has already limited
 * both lists to the authenticated account and explicitly selected team. */
export function interruptedFixtures({ profiles, bots, sessions, identity, workspaceId }) {
  check(Array.isArray(profiles) && profiles.length <= 100 && Array.isArray(bots?.items)
    && bots.live?.ownerId === identity.user.id && bots.live.workspaceId === workspaceId
    && Array.isArray(sessions) && sessions.length <= 100, 'scope_refused')
  const found = profiles.filter(p => /^测试1505 [a-f0-9]{8} (claude_code|codex)$/.test(p.name ?? '') && within(p.createdAt))
  check(found.length <= 2, 'fixture_ambiguous')
  const prefixes = new Set(found.map(p => p.name.split(' ')[1]))
  check(prefixes.size <= 1 && new Set(found.map(p => p.harness)).size === found.length, 'fixture_ambiguous')
  for (const p of found) check(uuid(p.id) && p.version === 1 && !p.archivedAt && within(p.updatedAt)
    && p.description === 'Temporary startup measurement' && p.enabled === true
    && p.name.endsWith(' ' + p.harness) && ['claude_code', 'codex'].includes(p.harness)
    && p.model?.mode === 'fixed' && p.model.harness === p.harness && p.model.source?.kind === 'subscription'
    && p.model.model === (p.harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5'), 'fixture_changed')
  const matchingBots = found.length ? bots.items.filter(b => b.name === '测试1505 ' + [...prefixes][0] && !b.coordinator) : []
  check(!found.length || matchingBots.length === 1 && uuid(matchingBots[0].id), 'fixture_ambiguous')
  const oldSessions = sessions.filter(s => within(s.createdAt))
  check(oldSessions.length <= 1, 'fixture_ambiguous')
  for (const s of oldSessions) check(s.userId === identity.user.id && s.id !== identity.session.id
    && s.token !== identity.session.token && within(s.updatedAt) && s.userAgent === 'node'
    && typeof s.token === 'string' && s.token.length >= 32 && s.token.length <= 512, 'session_failed')
  return { profiles: found, botId: matchingBots[0]?.id, sessions: oldSessions }
}

export async function recoverInterruptedLeaseAudit(env, { makeClient = createSessionClient,
  account = smokeAcceptanceAccount, selectTeam = selectTeamWorkspace } = {}) {
  const applicationSha = auditTarget(env)
  check(env.LEASE_AUDIT_RECOVERY_RUN === RUN, 'scope_refused')
  const report = { interruptedRunId: RUN, interruptedJobId: 128547182838, status: 'failed',
    profilesArchived: 0, oldSessionsRevoked: 0, botRetention: 'retained_no_delete_api', cleanup: {} }
  const client = makeClient(ORIGIN)
  let signedIn = false, originalWorkspaceId, botId
  const pin = async () => check((await client.json('/api/version')).build === applicationSha, 'scope_refused')
  try {
    await pin()
    const { email, password } = account(env)
    const login = await client.request('/api/auth/sign-in/email', post({ email, password }))
    check(login.ok, 'identity_failed'); signedIn = true
    const identity = await client.json('/api/auth/get-session?disableCookieCache=true')
    check(identity.user?.email?.toLowerCase() === email.toLowerCase()
      && typeof identity.session?.id === 'string' && identity.session.id.length > 0, 'identity_failed')
    originalWorkspaceId = (await client.json('/api/workspace')).workspace?.id
    let workspaceId
    const selected = await selectTeam({ ownerId: identity.user.id, onSelected: value => { workspaceId = value.workspaceId },
      json: (path, body) => client.json(path.slice('/mikka'.length),
      body ? { ...post(body), headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' } } : undefined) })
    check(uuid(workspaceId) && selected.teamWorkspaceConfirmed === true, 'scope_refused')
    const listing = await client.json('/api/factory/agent-profiles?workspaceId=' + workspaceId)
    const bots = await client.rpc('bots.pollBots', [])
    const sessions = await client.json('/api/auth/list-sessions')
    const own = interruptedFixtures({ profiles: listing.profiles, bots, sessions, identity, workspaceId })
    botId = own.botId
    for (const p of own.profiles) {
      const archived = await client.json('/api/factory/agent-profiles/' + p.id,
        { ...post({ workspaceId, version: p.version }), method: 'DELETE' })
      check(archived.profile?.id === p.id && archived.profile.archivedAt, 'archive_failed')
      const reread = await client.json('/api/factory/agent-profiles/' + p.id + '?workspaceId=' + workspaceId)
      check(reread.profile?.id === p.id && reread.profile.archivedAt && reread.profile.enabled === false, 'archive_failed')
      report.profilesArchived++
    }
    for (const s of own.sessions) {
      const result = await client.json('/api/auth/revoke-session', post({ token: s.token }))
      check(result.status === true, 'session_failed')
      const remaining = await client.json('/api/auth/list-sessions')
      check(Array.isArray(remaining) && !remaining.some(row => row.id === s.id || row.token === s.token), 'session_failed')
      report.oldSessionsRevoked++
    }
    if (botId) report.retainedBotIdHash = hash(botId)
    await pin()
    report.status = 'passed'
  } catch (error) { report.error = codes.has(error?.message) ? error.message : 'recovery_failed' }
  finally {
    if (signedIn) {
      try {
        check(uuid(originalWorkspaceId), 'scope_refused')
        await client.rpc('workspace.switchWorkspace', [originalWorkspaceId]); report.cleanup.workspaceRestored = true
      } catch { report.cleanup.error = 'workspace_restore_failed'; report.status = 'failed' }
      try {
        check((await client.request('/api/auth/sign-out', post({}))).ok, 'session_failed')
        report.cleanup.ownSessionClosed = true
      } catch { report.cleanup.error = 'session_close_failed'; report.status = 'failed' }
    }
    client.clear()
  }
  // The reusable Bot is internal to this process; its ID is never a credential.
  return { botId: report.status === 'passed' ? botId : undefined, evidence: report }
}
