// Final normal product deletion of the newly created ACME acceptance team only.
// Explicit receipts, sole owner, exact bots/groups, idle chats and zero tasks/teams/
// purchased points are required. No personal or pre-existing workspace qualifies.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ALEX_OWNER_ID, alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { readJson, rpc, validateChat } from '../issue-1504-1506/coordinator-baseline.mjs'
import { OUTPUT_DIR, ref, selectOwnedWorkspace } from './workspace-setup.mjs'
import { loadFixtureReceipt, validateFixtureReceipt, verifyOwnedFixture, fixtureError } from './coordinator-fixtures.mjs'
import { groupName, validateGroupMembers, validateGroupReceipt } from './group-stop.mjs'

const fail = code => { throw new Error(code) }
const ERRORS = new Set(['cleanup_scope_mismatch', 'cleanup_not_idle', 'cleanup_group_pending', 'cleanup_impact_mismatch',
  'cleanup_delete_unknown', 'cleanup_delete_failed', 'acceptance_signout_failed'])
const errorCode = error => ERRORS.has(error?.message) ? error.message : fixtureError(error)
export async function cleanupWorkspace({ fixtureReceipt: suppliedFixture = null, fixturePath = null,
  groupReceipts = [], sessionProvider = alexSession, checkpoint = true } = {}) {
  const fixtures = suppliedFixture ? validateFixtureReceipt(suppliedFixture) : loadFixtureReceipt(fixturePath)
  if (!Array.isArray(groupReceipts) || groupReceipts.length > 12) fail('cleanup_scope_mismatch')
  for (const group of groupReceipts) {
    validateGroupReceipt(group, fixtures)
    if (!group.groupId || group.cleanup?.status !== 'complete' || group.cleanup?.hidden !== true) fail('cleanup_group_pending')
  }
  if (new Set(groupReceipts.map(group => group.groupId)).size !== groupReceipts.length) fail('cleanup_scope_mismatch')
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-workspace-cleanup', status: 'failed',
    workspaceId: fixtures.workspace.id, workspaceRef: fixtures.workspace.ref, ownerRef: ref(ALEX_OWNER_ID),
    fixtureRunKey: fixtures.runKey, deleteAttempts: 0, modelMessages: 0, startedAt: new Date().toISOString(), requests: [] }
  let requests = []
  const save = () => {
    report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
    if (!checkpoint) return
    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(OUTPUT_DIR + '/workspace-cleanup.json', JSON.stringify(report, null, 2) + '\n')
  }
  try {
    await sessionProvider(async session => {
      requests = session.requests
      await selectOwnedWorkspace(session, fixtures)
      const bots = await readJson(session, '/api/bots')
      const expectedBots = fixtures.fixtures.filter(row => row.botId)
      if (!Array.isArray(bots) || bots.length !== expectedBots.length) fail('cleanup_scope_mismatch')
      for (const row of expectedBots) {
        const matches = bots.filter(bot => bot.id === row.botId)
        if (matches.length !== 1) fail('cleanup_scope_mismatch')
        verifyOwnedFixture(matches[0], fixtures, row)
        const chat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [row.botId]))
        if (chat.botId !== row.botId || chat.working || chat.streamRunId) fail('cleanup_not_idle')
      }
      const groups = await readJson(session, '/api/conversations?workspaceId=' + fixtures.workspace.id)
      if (groups?.viewerId !== ALEX_OWNER_ID || groups.workspaceId !== fixtures.workspace.id ||
        !Array.isArray(groups.conversations) || groups.conversations.length !== groupReceipts.length) fail('cleanup_scope_mismatch')
      for (const group of groups.conversations) {
        const receipt = groupReceipts.find(row => row.groupId === group.id)
        if (!receipt || group.kind !== 'group' || group.createdBy !== ALEX_OWNER_ID ||
          group.workspaceId !== fixtures.workspace.id || group.title !== groupName(receipt)) fail('cleanup_scope_mismatch')
        const members = await readJson(session, `/api/conversations/${group.id}/members`)
        const present = validateGroupMembers(members, expectedBots.map(row => row.botId), { allowRemovedBots: true })
        if (present.length !== 0) fail('cleanup_group_pending')
        const state = await readJson(session, `/api/conversations/${group.id}/messages?limit=1`)
        if (state?.agentStatus !== null) fail('cleanup_not_idle')
      }
      const impact = await rpc(session, 'workspace-settings.getWorkspaceDeletionImpact', [fixtures.workspace.id])
      if (impact?.bots !== expectedBots.length || impact.tasks !== 0 || impact.teams !== 0 || impact.purchasedPoints !== 0) fail('cleanup_impact_mismatch')
      report.impact = { bots: impact.bots, tasks: impact.tasks, teams: impact.teams, purchasedPoints: impact.purchasedPoints }
      report.guards = { onlyExpectedMember: true, onlyReceiptBots: true, onlyReceiptGroups: true, allObservedIdle: true }
      report.deleteAttempts++; save()
      let result, ack = false
      try { result = await rpc(session, 'workspace-settings.deleteWorkspace', [fixtures.workspace.id, fixtures.workspace.name], { timeoutMs: 60_000 }); ack = true }
      catch { report.deleteAcknowledgement = 'unknown_no_retry' }
      // One authoritative session inventory after the one delete request. Never retry a write.
      const after = await readJson(session, '/api/workspace/switcher')
      const account = after.accounts?.find(row => row.id === ALEX_OWNER_ID)
      if (!Array.isArray(account?.choices)) fail('cleanup_delete_unknown')
      if (account.choices.some(row => row.id === fixtures.workspace.id)) fail(ack ? 'cleanup_delete_failed' : 'cleanup_delete_unknown')
      report.absentFromOwnerWorkspaceChoices = true
      report.deleteAcknowledgement = ack ? 'acknowledged' : 'absent_after_unknown_no_retry'
      if (result?.deleted && Object.values(result.deleted).every(value => Number.isSafeInteger(value) && value >= 0)) {
        report.deletedCounts = Object.fromEntries(['bots', 'threads', 'tasks', 'projects', 'teams', 'invitations', 'members'].map(key => [key, result.deleted[key] ?? null]))
      }
      report.status = 'deleted'
    }, { expectedSha: null, deadlineAt: Date.now() + 240_000 })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = errorCode(error) }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.finishedAt = new Date().toISOString(); save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const groups = process.argv.slice(3).map(path => JSON.parse(readFileSync(path, 'utf8')))
    const report = await cleanupWorkspace({ fixturePath: process.argv[2], groupReceipts: groups })
    console.log(JSON.stringify(report))
    if (report.status !== 'deleted') process.exitCode = 1
  } catch (error) { console.log(JSON.stringify({ issue: 1506, phase: 'alex-workspace-cleanup', status: 'failed', error: errorCode(error) })); process.exitCode = 1 }
}
