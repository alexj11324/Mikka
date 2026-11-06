// Final cleanup for the one smoke-owned team created by workspace-provision.
// All writes use the ordinary signed-in product API. No retries or polling.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decode, productionSession } from '../issue-1504-1506/production-session.mjs'

export const TARGET = Object.freeze({
  id: 'd32ed7ad-4253-47dd-a94a-66b24dd07d35', ref: 'e917cd887945',
  name: 'Issues 1504-1506 production acceptance', slug: 'acceptance-1504-1506-42274865746',
  ownerHash: 'b823ba1c5729768b1da5c3615aba91ac39723bd4c54e9f382b3ed1368d58ec6e',
  temporaryMemberHash: '0cbf61fc889eb83126c705bd2a0e8c060eb2877e6acdd494db46244d313d86fe',
})
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const ref = value => hash(value).slice(0, 12)
const fail = code => { throw new Error(code) }
const CODES = new Set(['cleanup_mode_invalid', 'cleanup_receipt_invalid', 'acceptance_identity_mismatch',
  'acceptance_version_invalid', 'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_signout_failed',
  'smoke_credentials_missing', 'acceptance_deadline_exceeded', 'workspace_scope_mismatch', 'workspace_not_owned',
  'workspace_members_changed', 'workspace_switch_failed', 'workspace_inventory_invalid', 'workspace_resources_unexpected',
  'workspace_resources_active', 'routing_fixture_not_cleaned', 'workspace_deletion_outcome_unknown', 'workspace_deletion_invalid',
  'workspace_deletion_not_observed', 'workspace_audit_required', 'workspace_audit_expired'])
const safeError = error => ({ error: CODES.has(error?.message) ? error.message : 'workspace_cleanup_failed',
  ...(Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599 ? { httpStatus: error.details.status } : {}) })
const CASES = ['text-normalization', 'event-rollup', 'leased-job-queue']
const COORDINATOR_CASES = ['first-text-and-model-stream-stop', 'complete-short-turns', 'real-web-search-tool-call-stop']

/** Receipts are a resource allowlist, never instructions or arbitrary API paths. */
function acceptedFixtures(receipts) {
  if (!Array.isArray(receipts) || receipts.length > 24) fail('cleanup_receipt_invalid')
  const routing = new Map(), coordinator = new Set(), issueIds = new Set()
  let audit = null
  for (const receipt of receipts) {
    if (receipt?.schemaVersion !== 1) fail('cleanup_receipt_invalid')
    if (receipt.phase === 'workspace-scope-audit') {
      if (audit || receipt.workspaceId !== TARGET.id || receipt.workspaceRef !== TARGET.ref || receipt.name !== TARGET.name ||
        receipt.slug !== TARGET.slug || receipt.ownerHash !== TARGET.ownerHash || !Array.isArray(receipt.botIds) ||
        receipt.botIds.some(id => !UUID.test(id)) || new Set(receipt.botIds).size !== receipt.botIds.length ||
        !Array.isArray(receipt.runs) || receipt.runs.length > 200 || !Array.isArray(receipt.factoryTasks) || receipt.factoryTasks.length > 50 ||
        receipt.subagents !== 0 || receipt.conversations !== 0 || receipt.teams !== 0 ||
        receipt.teamIssues !== 0 || receipt.projects !== 0) fail('cleanup_receipt_invalid')
      audit = receipt; continue
    }
    if (!SHA.test(receipt.applicationSha ?? '')) fail('cleanup_receipt_invalid')
    if (receipt.issue === 1504 && receipt.phase === 'routing-production') {
      if (receipt.workspaceRef !== TARGET.ref || receipt.ownerRef !== TARGET.ownerHash.slice(0, 12) ||
        !/^[a-zA-Z0-9_-]{1,36}$/.test(receipt.runKey ?? '') || !Array.isArray(receipt.cases) || receipt.cases.length !== 3 ||
        receipt.cleanup?.status !== 'complete' || receipt.retainedFixtures !== false) fail('routing_fixture_not_cleaned')
      if (receipt.botId === null && receipt.cases.every(row => row.issueId === null)) continue
      if (!UUID.test(receipt.botId ?? '') || routing.has(receipt.botId)) fail('cleanup_receipt_invalid')
      const cases = CASES.map(key => {
        const matches = receipt.cases.filter(row => row.key === key)
        if (matches.length !== 1) fail('cleanup_receipt_invalid')
        const row = matches[0]
        if (row.issueId === null && row.createAttempted !== true) return null
        if (!UUID.test(row.issueId ?? '') || row.deleted !== true || issueIds.has(row.issueId)) fail('routing_fixture_not_cleaned')
        issueIds.add(row.issueId)
        return { id: row.issueId, title: `[acceptance-1504:${receipt.runKey}] ${key}` }
      }).filter(Boolean)
      routing.set(receipt.botId, { name: `Acceptance 1504 ${receipt.runKey}`, cases })
    } else if (receipt.issue === 1506 && (receipt.phase === 'coordinator-setup' || COORDINATOR_CASES.includes(receipt.case))) {
      if (receipt.workspace?.ref !== TARGET.ref || !/^[0-9a-f]{12}$/.test(receipt.botRef ?? '')) fail('cleanup_receipt_invalid')
      if (receipt.botId !== undefined && (!UUID.test(receipt.botId ?? '') || ref(receipt.botId) !== receipt.botRef)) fail('cleanup_receipt_invalid')
      coordinator.add(receipt.botRef)
    } else fail('cleanup_receipt_invalid')
  }
  if (coordinator.size > 1) fail('cleanup_receipt_invalid')
  if (!audit) fail('workspace_audit_required')
  for (const at of [audit.checkedAt, audit.appCheckedAt]) {
    const age = Date.now() - Date.parse(at)
    if (!Number.isFinite(age) || age < -30_000 || age > 600_000) fail('workspace_audit_expired')
  }
  return { routing, coordinator, issueIds, audit }
}

export async function cleanupWorkspace({ mode = 'inspect', receipts = [], checkpoint = true, sessionProvider = productionSession } = {}) {
  const started = Date.now()
  const report = { schemaVersion: 1, issues: [1504, 1506], phase: 'workspace-cleanup', mode, status: 'failed',
    workspaceId: TARGET.id, workspaceRef: TARGET.ref, smokeOwnerRef: TARGET.ownerHash.slice(0, 12), applicationSha: null,
    deletionAttempted: false, deletionAcknowledged: false, deletionObserved: false, requests: [],
    ownershipEvidence: 'fresh_exact_workspace_database_audit_and_current_owner_session_permissions',
    residualShareCheck: 'parent_verifies_exact_workspace_after_deletion' }
  let requests = []
  const save = () => {
    report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
    if (!checkpoint) return
    mkdirSync('issue-1504-1506-report', { recursive: true })
    const path = 'issue-1504-1506-report/workspace-cleanup.json'
    writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path)
  }
  try {
    if (!['inspect', 'delete'].includes(mode)) fail('cleanup_mode_invalid')
    const accepted = acceptedFixtures(receipts)
    await sessionProvider(async session => {
      requests = session.requests
      const ownerId = session.identity.userId
      if (hash(ownerId) !== TARGET.ownerHash) fail('acceptance_identity_mismatch')
      if (!SHA.test(session.version?.build ?? '')) fail('acceptance_version_invalid')
      report.applicationSha = session.version.build
      const json = async (path, options = {}) => {
        const response = await session.request(path, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 25_000) })
        const value = await response.json().catch(() => null)
        if (!response.ok || value?.error) {
          const error = new Error('acceptance_http_failed'); error.details = { status: response.status }; throw error
        }
        return value
      }
      const rpc = async (action, args = [], timeoutMs = 25_000) => {
        const envelope = await json('/api/rpc', { body: { version: 1, action, args }, headers: { 'x-mikka-rpc': '1' }, timeoutMs })
        const result = decode(envelope?.result)
        if (envelope?.ok !== true || result?.error || result?.ok === false) fail('acceptance_rpc_failed')
        return result
      }
      const discover = async () => {
        const switcher = await json('/api/workspace/switcher')
        const account = switcher.accounts?.find(row => row.id === ownerId)
        if (!account || !Array.isArray(account.choices)) fail('workspace_inventory_invalid')
        const target = account.choices.filter(row => row.id === TARGET.id)
        if (target.length > 1 || target.some(row => row.kind !== 'team' || row.name !== TARGET.name || ref(row.id) !== TARGET.ref)) fail('workspace_scope_mismatch')
        return { exists: target.length === 1, selected: switcher.workspace?.id === TARGET.id }
      }
      const first = await discover()
      if (!first.exists) { report.status = 'already_absent'; report.deletionObserved = true; return }
      const switched = await rpc('workspace.switchWorkspace', [TARGET.id])
      if (switched?.ok !== true || switched.data?.workspaceId !== TARGET.id || !(await discover()).selected) fail('workspace_switch_failed')
      const metadata = await json('/api/workspace?workspace=' + TARGET.id)
      const general = await rpc('workspace-settings.getWorkspaceGeneral', [TARGET.id])
      if (metadata.workspace?.id !== TARGET.id || metadata.workspace.name !== TARGET.name || metadata.workspace.kind !== 'team' ||
        metadata.currentUserId !== ownerId || general.id !== TARGET.id || general.name !== TARGET.name || general.slug !== TARGET.slug || general.personal !== false) fail('workspace_scope_mismatch')
      if (metadata.role !== 'admin' || general.canEdit !== true || general.canTransfer !== true) fail('workspace_not_owned')
      const members = metadata.members
      if (!Array.isArray(members) || ![1, 2].includes(members.length) ||
        members.filter(member => member.userId === ownerId && member.role === 'admin' && member.status === 'active').length !== 1 ||
        members.some(member => member.userId !== ownerId && (typeof member.userId !== 'string' || hash(member.userId) !== TARGET.temporaryMemberHash || member.role !== 'member' || member.status !== 'active')) ||
        !Array.isArray(metadata.invitations) || metadata.invitations.length !== 0) fail('workspace_members_changed')
      report.members = { count: members.length, smokeAdmin: true, temporaryMemberPresent: members.length === 2, invitations: 0 }
      const impact = await rpc('workspace-settings.getWorkspaceDeletionImpact', [TARGET.id])
      const inventory = await rpc('bots.listWorkspaceBots')
      const bots = inventory?.bots
      if (!Array.isArray(bots) || !Number.isInteger(impact?.bots) || impact.bots !== bots.length || impact.tasks !== 0 || impact.teams !== 0 || impact.purchasedPoints !== 0 ||
        bots.length !== accepted.audit.botIds.length || bots.some(bot => !accepted.audit.botIds.includes(bot.id))) fail('workspace_resources_unexpected')
      const allowedIds = new Set()
      report.resources = { bots: bots.length, runs: 0, factoryTasks: 0, personalIssuesVerifiedDeleted: 0, teams: 0, teamTasks: 0, purchasedPoints: 0, projects: 0, conversations: 0, subagents: 0 }
      for (const bot of bots) {
        if (!UUID.test(bot.id ?? '') || allowedIds.has(bot.id) || bot.ownerId !== ownerId) fail('workspace_resources_unexpected')
        allowedIds.add(bot.id)
        const fixture = accepted.routing.get(bot.id), coordinator = accepted.coordinator.has(ref(bot.id))
        if (fixture && coordinator || !fixture && !coordinator || fixture && bot.name !== fixture.name) fail('workspace_resources_unexpected')
        if (bot.status !== 'idle' || bot.runningThreads !== 0) fail('workspace_resources_active')
        if (coordinator) {
          const result = await rpc('coordinator.syncCoordinatorChat', [bot.id])
          if (result.chat?.botId !== bot.id || result.chat.working !== false || result.chat.streamRunId) fail('workspace_resources_active')
        }
      }
      const runIds = new Set()
      for (const run of accepted.audit.runs) {
        if (!UUID.test(run.id ?? '') || runIds.has(run.id) || !allowedIds.has(run.botId) || run.ownerHash !== TARGET.ownerHash) fail('workspace_resources_unexpected')
        runIds.add(run.id)
        const fixture = accepted.routing.get(run.botId)
        if (fixture ? !fixture.cases.some(issue => issue.id === run.issueId) : run.issueId !== null) fail('workspace_resources_unexpected')
        if (!['succeeded', 'stopped', 'failed', 'cancelled'].includes(run.status)) fail('workspace_resources_active')
      }
      const factoryIds = new Set()
      for (const task of accepted.audit.factoryTasks) {
        const fixture = accepted.routing.get(task.botId)
        if (!UUID.test(task.id ?? '') || factoryIds.has(task.id) || task.ownerHash !== TARGET.ownerHash || !fixture ||
          !fixture.cases.some(issue => issue.id === task.issueId)) fail('workspace_resources_unexpected')
        if (!['cancelled', 'revoked', 'published'].includes(task.status)) fail('workspace_resources_active')
        factoryIds.add(task.id)
      }
      report.resources.runs = runIds.size; report.resources.factoryTasks = factoryIds.size
      report.scopeAudit = { checkedAt: new Date(accepted.audit.checkedAt).toISOString(), runs: runIds.size,
        currentOwnerVerified: true, allWorkspaceConversations: 0 }
      // Personal tasks survive deleting a workspace. Require their normal driver
      // cleanup to have completed, then verify only the exact receipt task ids.
      for (const fixture of accepted.routing.values()) for (const issue of fixture.cases) {
        const deleted = await rpc('issue-operations.getDeletedIssue', [issue.id])
        if (deleted?.id !== issue.id || deleted.title !== issue.title || !deleted.deletedAt) fail('routing_fixture_not_cleaned')
        report.resources.personalIssuesVerifiedDeleted++
      }
      report.guardPassed = true; save()
      if (mode === 'inspect') { report.status = 'ready_to_delete'; return }
      if ([accepted.audit.checkedAt, accepted.audit.appCheckedAt].some(at => Date.now() - Date.parse(at) > 600_000)) fail('workspace_audit_expired')
      report.deletionAttempted = true; save()
      let deleted
      try { deleted = await rpc('workspace-settings.deleteWorkspace', [TARGET.id, TARGET.name], 90_000) }
      catch (error) {
        report.deleteError = safeError(error)
        // Never repeat an irreversible write after a lost acknowledgement.
        const observed = await discover().catch(() => null)
        report.unavailableAfterUnknown = observed ? !observed.exists : null
        fail('workspace_deletion_outcome_unknown')
      }
      report.deletionAcknowledged = true
      const counts = deleted?.deleted
      if (!counts || !['bots', 'threads', 'tasks', 'projects', 'teams', 'invitations', 'members'].every(key => Number.isInteger(counts[key]) && counts[key] >= 0) ||
        counts.bots !== bots.length || counts.threads !== runIds.size || counts.tasks !== 0 || counts.projects !== 0 || counts.teams !== 0 || counts.invitations !== 0 || counts.members !== members.length) fail('workspace_deletion_invalid')
      report.deleted = Object.fromEntries(['bots', 'threads', 'tasks', 'projects', 'teams', 'invitations', 'members'].map(key => [key, counts[key]])); save()
      if ((await discover()).exists) fail('workspace_deletion_not_observed')
      report.deletionObserved = true; report.status = 'deleted'
    }, { expectedSha: null, deadlineAt: started + 300_000 })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; Object.assign(report, safeError(error)) }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.durationMs = Date.now() - started; save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipts = process.argv.slice(3).map(path => JSON.parse(readFileSync(path, 'utf8')))
    const report = await cleanupWorkspace({ mode: process.argv[2] ?? 'inspect', receipts })
    console.log(JSON.stringify(report))
    if (!['ready_to_delete', 'deleted', 'already_absent'].includes(report.status)) process.exitCode = 1
  } catch { console.log(JSON.stringify({ phase: 'workspace-cleanup', status: 'failed', error: 'cleanup_receipt_invalid' })); process.exitCode = 1 }
}
