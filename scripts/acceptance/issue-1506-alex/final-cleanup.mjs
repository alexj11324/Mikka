// Explicit post-acceptance cleanup only. No model, Stop, setup or polling path.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALEX_OWNER_ID, alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { readJson, rpc, validateChat } from '../issue-1504-1506/coordinator-baseline.mjs'
import { OUTPUT_DIR, ref, selectOwnedWorkspace, UUID } from './workspace-setup.mjs'
import { fixtureError, validateFixtureReceipt, verifyOwnedFixture } from './coordinator-fixtures.mjs'
import { groupName, validateGroupMembers, validateGroupReceipt } from './group-stop.mjs'
import { cleanupWorkspace } from './cleanup-workspace.mjs'

export const CLEANUP_SCOPE = Object.freeze({
  workspaceId: '0a700222-137b-4bca-b86d-a74b8fdffc21', runKey: 'acme-1506-20261106',
  botIds: Object.freeze(['9df34d90-6db6-407e-a2d2-bfd4ac616c58', '8ff8b30e-2eb9-48bd-987f-4cbf048944d7']),
  auditStatementSha256: 'e16efac4053b581bf67aff3758300d80999e9ef6a9fb56c43ca7fe6d8121ff08',
})
// The raw fixture hash is checked by the input manifest; exact owner/team/bots
// below remain mandatory even when a new serialized copy of that receipt is used.
const CASES = ['public-haiku', 'public-luna', 'private-haiku', 'private-luna']
const HASH = /^[0-9a-f]{64}$/, SHA = /^[0-9a-f]{40}$/
const fail = code => { throw new Error(code) }
const ERRORS = new Set(['cleanup_evidence_invalid', 'cleanup_evidence_scope', 'cleanup_host_terminal_missing',
  'cleanup_audit_not_passed', 'cleanup_receipt_hash_mismatch', 'cleanup_case_set_mismatch', 'cleanup_cases_unfinished',
  'cleanup_inventory_changed', 'cleanup_current_group_changed', 'cleanup_members_changed', 'cleanup_write_unconfirmed',
  'cleanup_progress_invalid', 'cleanup_groups_incomplete', 'cleanup_bot_active', 'cleanup_impact_mismatch',
  'cleanup_delete_pending', 'cleanup_input_invalid', 'acceptance_signout_failed'])
const safeError = error => ERRORS.has(error?.message) ? error.message : fixtureError(error)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN
const same = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === b.length && b.every(id => a.includes(id))
const integer = value => Number.isSafeInteger(value) && value >= 0
const zero = values => values.every(value => value === 0)

export function validateCleanupEvidence(evidence) {
  const { manifest, fixtures, cases, manifestSha256 } = evidence ?? {}
  if (manifest?.schemaVersion !== 1 || manifest.issue !== 1506 || manifest.phase !== 'alex-final-cleanup-evidence' ||
    typeof manifest.allCasesCompleted !== 'boolean' || !SHA.test(manifest.applicationSha ?? '') || !HASH.test(manifestSha256 ?? '')) fail('cleanup_evidence_invalid')
  validateFixtureReceipt(fixtures, { ready: true })
  if (fixtures.ownerRef !== ref(ALEX_OWNER_ID) || fixtures.workspace.id !== CLEANUP_SCOPE.workspaceId || fixtures.runKey !== CLEANUP_SCOPE.runKey ||
    !same(fixtures.fixtures.map(row => row.botId), CLEANUP_SCOPE.botIds) ||
    fixtures.fixtures.find(row => row.key === 'haiku')?.botId !== CLEANUP_SCOPE.botIds[0]) fail('cleanup_evidence_scope')
  if (!Array.isArray(cases) || !same(cases.map(row => row.key), CASES) ||
    new Set(cases.map(row => row.group?.groupId)).size !== 4 || new Set(cases.map(row => row.group?.messageId)).size !== 4) fail('cleanup_case_set_mismatch')
  for (const row of cases) {
    const { group, terminal, audit: receipt, hashes } = row
    validateGroupReceipt(group, fixtures)
    if (row.key !== `${group.scenario}-${group.fixtureKey}` || group.applicationSha !== manifest.applicationSha ||
      !UUID.test(group.groupId ?? '') || !UUID.test(group.messageId ?? '') || group.mode !== 'observe' ||
      group.status !== 'stop_evidence_captured' || group.signedOut !== true || group.createAttempted !== true ||
      group.messageSendAttempts !== 1 || group.stop?.requested !== true || group.stop?.acknowledged !== true || group.stop.stoppedTurns !== 1 ||
      group.cleanup?.hidden !== false || !same(group.cleanup?.retainedBotIds, CLEANUP_SCOPE.botIds) ||
      !Array.isArray(group.cleanup?.removedBotIds) || group.cleanup.removedBotIds.length ||
      !HASH.test(hashes?.group ?? '') || !HASH.test(hashes?.terminal ?? '') || !HASH.test(hashes?.audit ?? '')) fail('cleanup_evidence_scope')
    if (terminal?.schemaVersion !== 1 || terminal.issue !== 1506 || terminal.applicationSha !== group.applicationSha ||
      terminal.source !== 'vercel_runtime_logs' || !Array.isArray(terminal.records) || terminal.records.length !== 1 ||
      !Number.isFinite(date(terminal.capturedAt))) fail('cleanup_host_terminal_missing')
    const end = terminal.records[0]
    if (!Number.isFinite(date(group.sentAt)) || end?.event !== 'group_turn_terminal' || end.conversationId !== group.groupId || end.messageId !== group.messageId ||
      !integer(end.started) || end.started < 1 || end.settled !== end.started || !integer(end.aborted) || end.aborted > end.settled ||
      end.sessionLost !== false || !integer(end.endedAt) || end.endedAt < date(group.sentAt) || end.endedAt > date(terminal.capturedAt)) fail('cleanup_host_terminal_missing')
    if (receipt?.schemaVersion !== 1 || receipt.issue !== 1506 || receipt.applicationSha !== group.applicationSha ||
      receipt.statementSha256 !== CLEANUP_SCOPE.auditStatementSha256 || receipt.terminalReceiptSha256 !== hashes.terminal ||
      receipt.executedOnce !== true || !Number.isFinite(date(receipt.startedAt)) || date(receipt.startedAt) < date(terminal.capturedAt)) fail('cleanup_audit_not_passed')
    const audit = receipt.audit, scope = audit?.scope, member = audit?.membership, turn = audit?.turn,
      pub = audit?.public, priv = audit?.private, trace = audit?.trace, delegation = audit?.delegation, active = audit?.activeSession
    if (![scope, member, turn, pub, priv, trace, delegation, active].every(value => value && typeof value === 'object')) fail('cleanup_audit_not_passed')
    if (audit?.schemaVersion !== 1 || audit.issue !== 1506 || audit.scopeMatched !== true || !Number.isFinite(date(audit.observedAt)) ||
      scope?.groupId !== group.groupId || scope.messageId !== group.messageId || scope.workspaceId !== fixtures.workspace.id || scope.ownerMatches !== true ||
      member?.intact !== true || member.total !== 3 || member.active !== 3 || member.activeExpectedOwner !== 1 || member.activeExpectedBots !== 2 ||
      !zero([member.unexpectedMembers, member.departed]) || turn?.status !== 'failed' || turn.isStopped !== true || turn.hasOtherError !== false ||
      turn.agentActive !== false || turn.botActive !== false || turn.activeRunId !== null || turn.nextDecisionAt !== null || turn.traceStatus !== 'stopped' || turn.traceEventsArray !== true ||
      audit.cancellationFeedbackCount !== 1 || active?.source !== 'exact_group_advisory_lock' || !zero([active.locks, active.held, active.waiters]) || active.rowsTruncated !== false ||
      !integer(pub?.replyCount) || pub.replyCount !== group.afterStop?.botReplyCount || pub.totalGroupMessages !== pub.replyCount + 1 ||
      !zero([pub.otherUserRoots, pub.unexpectedAuthors]) || pub.rowsTruncated !== false || !Array.isArray(pub.rows) || pub.rows.length !== pub.replyCount ||
      !zero([priv?.foreignScopeLinks, priv.invalidMemberships, priv.otherAnchorLinks, priv.unexpectedAuthors]) || priv.linksTruncated !== false || priv.rowsTruncated !== false ||
      !Array.isArray(priv.rows) || priv.rows.length !== priv.actualMessages ||
      trace?.generateCount !== end.started || trace.publicPublishCount !== pub.replyCount || trace.publicPublishCount !== group.turn?.publicPublishes ||
      trace.privatePublishCount !== group.turn?.privatePublishes || !zero([trace.delegateCount, trace.taskEventCount, trace.unknownEvents]) || trace.eventsTruncated !== false ||
      !zero([delegation?.bindings, delegation.receipts, delegation.foreignOwnerBindings, delegation.foreignOwnerReceipts]) || delegation.entriesTruncated !== false) fail('cleanup_audit_not_passed')
    if (group.scenario === 'public') {
      if (!zero([priv.linkCount, priv.declaredMessages, priv.actualMessages, trace.privatePublishCount]) || !same(priv.links?.map(link => link.id), [])) fail('cleanup_audit_not_passed')
    } else {
      if (pub.replyCount !== 0 || priv.linkCount !== 1 || priv.declaredMessages !== 1 || priv.actualMessages !== 1 || trace.privatePublishCount !== 1 ||
        group.privateBoundary?.privateMessagesBeforeStop !== 1 || group.privateBoundary.targetGenerateRecorded !== true || group.privateBoundary.targetBotId !== fixtures.fixtures.find(bot => bot.key === group.fixtureKey)?.botId ||
        !Array.isArray(priv.links) || priv.links.length !== 1 || priv.links[0].id !== group.privateBoundary.linkId ||
        priv.links[0].ownedScope !== true || !UUID.test(priv.links[0].privateConversationId ?? '') || priv.links[0].messageCount !== 1) fail('cleanup_audit_not_passed')
    }
  }
  return evidence
}

function readFile(path, maxBytes) {
  const raw = readFileSync(path)
  if (raw.length > maxBytes) fail('cleanup_input_invalid')
  return { value: JSON.parse(raw.toString('utf8')), hash: digest(raw) }
}
export function loadCleanupEvidence(path) {
  const loaded = readFile(path, 80_000), manifest = loaded.value
  const load = descriptor => {
    if (!/^receipts\/[a-z0-9][a-z0-9-]*\.json$/.test(descriptor?.path ?? '') || !HASH.test(descriptor?.sha256 ?? '')) fail('cleanup_input_invalid')
    const file = readFile(resolve(dirname(path), descriptor.path), 500_000)
    if (file.hash !== descriptor.sha256) fail('cleanup_receipt_hash_mismatch')
    return file
  }
  const fixture = load(manifest.fixtureReceipt)
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 4) fail('cleanup_case_set_mismatch')
  const cases = manifest.cases.map(row => {
    const group = load(row.groupReceipt), terminal = load(row.terminalReceipt), audit = load(row.auditReceipt)
    return { key: row.key, group: group.value, terminal: terminal.value, audit: audit.value, hashes: { group: group.hash, terminal: terminal.hash, audit: audit.hash } }
  })
  return validateCleanupEvidence({ manifest, manifestSha256: loaded.hash, fixtures: fixture.value, cases })
}

export function cleanupInventory(evidence) {
  validateCleanupEvidence(evidence)
  return { ownerRef: ref(ALEX_OWNER_ID), workspaceId: evidence.fixtures.workspace.id, fixtureRunKey: evidence.fixtures.runKey,
    botIds: [...CLEANUP_SCOPE.botIds], groups: evidence.cases.map(({ key, group, audit }) => ({ key, groupId: group.groupId, messageId: group.messageId,
      privateConversationIds: audit.audit.private.links.map(link => link.privateConversationId) })),
    groupCount: 4, expectedBotCount: 2, expectedTasks: 0, expectedTeams: 0, expectedPurchasedPoints: 0 }
}

const progressRow = row => ({ key: row.key, groupId: row.group.groupId, messageId: row.group.messageId,
  removalAttempts: [], removedBotIds: [], hideAttempted: false, hidden: false, status: 'pending' })
export function validateGroupCleanupProgress(value, evidence, { complete = false } = {}) {
  if (value?.schemaVersion !== 1 || value.issue !== 1506 || value.phase !== 'alex-final-group-cleanup' || value.evidenceSha256 !== evidence.manifestSha256 ||
    value.workspaceId !== CLEANUP_SCOPE.workspaceId || value.ownerRef !== ref(ALEX_OWNER_ID) || !Array.isArray(value.groups) || !same(value.groups.map(row => row.key), CASES)) fail('cleanup_progress_invalid')
  for (const row of value.groups) {
    const original = evidence.cases.find(item => item.key === row.key)
    if (row.groupId !== original.group.groupId || row.messageId !== original.group.messageId ||
      !Array.isArray(row.removalAttempts) || row.removalAttempts.some(id => !CLEANUP_SCOPE.botIds.includes(id)) ||
      !Array.isArray(row.removedBotIds) || row.removedBotIds.some(id => !CLEANUP_SCOPE.botIds.includes(id)) ||
      typeof row.hideAttempted !== 'boolean' || typeof row.hidden !== 'boolean' || row.hidden && !row.hideAttempted ||
      !['pending', 'needs_followup', 'complete'].includes(row.status)) fail('cleanup_progress_invalid')
    if (complete && (value.status !== 'complete' || value.signedOut !== true || row.status !== 'complete' || row.hidden !== true ||
      !same(row.removedBotIds, CLEANUP_SCOPE.botIds) || CLEANUP_SCOPE.botIds.some(id => !row.removalAttempts.includes(id)))) fail('cleanup_groups_incomplete')
  }
  return value
}

async function api(session, path, options = {}) {
  const response = await session.request(path, { ...options, signal: AbortSignal.timeout(20_000) })
  const value = await response.json().catch(() => null)
  if (!response.ok || value?.error) fail('cleanup_write_unconfirmed')
  return value
}
async function inventory(session, evidence) {
  await selectOwnedWorkspace(session, evidence.fixtures)
  const bots = await readJson(session, '/api/bots')
  if (!Array.isArray(bots) || !same(bots.map(bot => bot.id), CLEANUP_SCOPE.botIds)) fail('cleanup_inventory_changed')
  for (const row of evidence.fixtures.fixtures) verifyOwnedFixture(bots.find(bot => bot.id === row.botId), evidence.fixtures, row)
  const listed = await readJson(session, '/api/conversations?workspaceId=' + CLEANUP_SCOPE.workspaceId)
  if (listed?.viewerId !== ALEX_OWNER_ID || listed.workspaceId !== CLEANUP_SCOPE.workspaceId ||
    !Array.isArray(listed.conversations) || !same(listed.conversations.map(group => group.id), evidence.cases.map(row => row.group.groupId))) fail('cleanup_inventory_changed')
  for (const group of listed.conversations) {
    const receipt = evidence.cases.find(row => row.group.groupId === group.id).group
    if (group.kind !== 'group' || group.createdBy !== ALEX_OWNER_ID || group.workspaceId !== CLEANUP_SCOPE.workspaceId || group.title !== groupName(receipt)) fail('cleanup_inventory_changed')
  }
  return listed.conversations
}
function verifyGroupState(value, row) {
  const expected = row.audit.audit, root = row.group.messageId
  if (value?.agentStatus !== null || value.stopped !== true || !Array.isArray(value.messages) || value.messages.length !== expected.public.totalGroupMessages ||
    value.messages.filter(message => message.id === root && message.authorType === 'user' && message.authorId === ALEX_OWNER_ID).length !== 1 ||
    value.messages.some(message => message.id !== root && (message.authorType !== 'bot' || !CLEANUP_SCOPE.botIds.includes(message.authorId) || message.replyToId !== root))) fail('cleanup_current_group_changed')
  const links = (value.timeline ?? []).filter(item => item.type === 'agent_exchange')
  if (!same(links.map(link => link.linkId), expected.private.links.map(link => link.id)) ||
    links.some(link => String(link.anchorPosition) !== String(expected.scope.rootPosition) || Number(link.count) !== 1)) fail('cleanup_current_group_changed')
}
function save(report, checkpoint) {
  if (!checkpoint) return
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const path = `${OUTPUT_DIR}/${report.phase}.json`
  writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path)
}
function requestMetadata(requests) { return requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs })) }
const signedOut = requests => requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)

export async function cleanupGroups(evidence, { previous = null, sessionProvider = alexSession, checkpoint = true } = {}) {
  validateCleanupEvidence(evidence)
  if (!evidence.manifest.allCasesCompleted) fail('cleanup_cases_unfinished')
  if (previous) validateGroupCleanupProgress(previous, evidence)
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-final-group-cleanup', status: 'failed',
    evidenceSha256: evidence.manifestSha256, workspaceId: CLEANUP_SCOPE.workspaceId, ownerRef: ref(ALEX_OWNER_ID),
    startedAt: new Date().toISOString(), modelCalls: 0, stopRequests: 0,
    groups: previous ? previous.groups.map(row => ({ key: row.key, groupId: row.groupId, messageId: row.messageId,
      removalAttempts: [...row.removalAttempts], removedBotIds: [...row.removedBotIds], hideAttempted: row.hideAttempted, hidden: row.hidden, status: row.status,
      ...(row.lastRemovalAcknowledgement === 'unknown_no_retry' ? { lastRemovalAcknowledgement: 'unknown_no_retry' } : {}) })) : evidence.cases.map(progressRow), requests: [] }
  let requests = []
  const checkpointNow = () => { report.requests = requestMetadata(requests); save(report, checkpoint) }
  try {
    await sessionProvider(async session => {
      if (!SHA.test(session.version?.build ?? '')) fail('acceptance_version_mismatch')
      requests = session.requests; report.applicationSha = session.version?.build
      await inventory(session, evidence)
      // Validate all four live resource scopes before the first member mutation.
      const present = new Map()
      for (const row of evidence.cases) {
        const progress = report.groups.find(item => item.key === row.key)
        const members = validateGroupMembers(await readJson(session, `/api/conversations/${row.group.groupId}/members`), CLEANUP_SCOPE.botIds, { allowRemovedBots: !!previous })
        if (previous && CLEANUP_SCOPE.botIds.some(id => !members.includes(id) && !progress.removalAttempts.includes(id))) fail('cleanup_members_changed')
        verifyGroupState(await readJson(session, `/api/conversations/${row.group.groupId}/messages?limit=100`), row)
        present.set(row.key, members)
      }
      for (const row of evidence.cases) {
        const progress = report.groups.find(item => item.key === row.key)
        try {
          for (const botId of present.get(row.key)) {
            progress.removalAttempts.push(botId); checkpointNow()
            try {
              const response = await api(session, `/api/conversations/${row.group.groupId}/members`, { method: 'DELETE', body: { memberType: 'bot', memberId: botId } })
              if (response?.ok !== true) fail('cleanup_write_unconfirmed')
            } catch { progress.lastRemovalAcknowledgement = 'unknown_no_retry' }
          }
          // One authoritative read after this group's finite writes, including lost ACKs.
          const remaining = validateGroupMembers(await readJson(session, `/api/conversations/${row.group.groupId}/members`), CLEANUP_SCOPE.botIds, { allowRemovedBots: true })
          progress.removedBotIds = CLEANUP_SCOPE.botIds.filter(id => !remaining.includes(id))
          if (remaining.length) fail('cleanup_write_unconfirmed')
          if (!progress.hidden) {
            progress.hideAttempted = true; checkpointNow()
            const hidden = await api(session, `/api/mobile/groups/${row.group.groupId}`, { method: 'PATCH', body: { hidden: true } })
            if (hidden?.ok !== true) fail('cleanup_write_unconfirmed')
            progress.hidden = true
          }
          progress.status = 'complete'; delete progress.error
        } catch (error) { progress.status = 'needs_followup'; progress.error = safeError(error) }
        checkpointNow()
      }
      report.status = report.groups.every(row => row.status === 'complete') ? 'complete' : 'needs_followup'
    }, { expectedSha: null, deadlineAt: Date.now() + 350_000 })
    if (!signedOut(requests)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = safeError(error) }
  report.signedOut = signedOut(requests); report.finishedAt = new Date().toISOString(); checkpointNow()
  return report
}

function cleanedGroupReceipt(row, progress) {
  const group = row.group
  return { schemaVersion: 1, issue: 1506, phase: 'alex-group-stop', ownerRef: group.ownerRef, workspaceId: group.workspaceId,
    fixtureRunKey: group.fixtureRunKey, fixtureKey: group.fixtureKey, scenario: group.scenario, boundary: group.boundary,
    applicationSha: group.applicationSha, groupId: group.groupId, messageId: group.messageId,
    cleanup: { status: progress.status, hidden: progress.hidden, removedBotIds: [...progress.removedBotIds] } }
}
export async function cleanupFinalWorkspace(evidence, groupProgress, { sessionProvider = alexSession, checkpoint = true, deleteWorkspace = cleanupWorkspace } = {}) {
  validateCleanupEvidence(evidence); validateGroupCleanupProgress(groupProgress, evidence, { complete: true })
  if (!evidence.manifest.allCasesCompleted) fail('cleanup_cases_unfinished')
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-final-workspace-cleanup', status: 'failed',
    evidenceSha256: evidence.manifestSha256, workspaceId: CLEANUP_SCOPE.workspaceId, ownerRef: ref(ALEX_OWNER_ID),
    startedAt: new Date().toISOString(), botHideAttempts: [], hiddenBotIds: [], modelCalls: 0, stopRequests: 0, requests: [] }
  let requests = []
  const checkpointNow = () => { report.requests = requestMetadata(requests); save(report, checkpoint) }
  try {
    await sessionProvider(async session => {
      if (!SHA.test(session.version?.build ?? '')) fail('acceptance_version_mismatch')
      requests = session.requests; report.applicationSha = session.version?.build
      await inventory(session, evidence)
      for (const row of evidence.cases) {
        const remaining = validateGroupMembers(await readJson(session, `/api/conversations/${row.group.groupId}/members`), CLEANUP_SCOPE.botIds, { allowRemovedBots: true })
        if (remaining.length) fail('cleanup_groups_incomplete')
        verifyGroupState(await readJson(session, `/api/conversations/${row.group.groupId}/messages?limit=100`), row)
      }
      // All bots are checked before either hide. No implicit Stop repairs an active case.
      for (const row of evidence.fixtures.fixtures) {
        const chat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [row.botId]))
        if (chat.botId !== row.botId || chat.working || chat.streamRunId) fail('cleanup_bot_active')
      }
      const impact = await rpc(session, 'workspace-settings.getWorkspaceDeletionImpact', [CLEANUP_SCOPE.workspaceId])
      if (impact?.bots !== 2 || !zero([impact.tasks, impact.teams, impact.purchasedPoints])) fail('cleanup_impact_mismatch')
      report.impact = { bots: impact.bots, tasks: impact.tasks, teams: impact.teams, purchasedPoints: impact.purchasedPoints }
      for (const botId of CLEANUP_SCOPE.botIds) {
        report.botHideAttempts.push(botId); checkpointNow()
        const hidden = await api(session, `/api/mobile/bots/${botId}`, { method: 'PATCH', body: { hidden: true } })
        if (hidden?.ok !== true) fail('cleanup_write_unconfirmed')
        report.hiddenBotIds.push(botId); checkpointNow()
      }
    }, { expectedSha: null, deadlineAt: Date.now() + 180_000 })
    if (!signedOut(requests)) fail('acceptance_signout_failed')
    // Existing normal deletion helper repeats its destructive-action inventory,
    // sends exactly one delete, and checks owner workspace absence once.
    report.deletion = await deleteWorkspace({ fixtureReceipt: evidence.fixtures,
      groupReceipts: evidence.cases.map(row => cleanedGroupReceipt(row, groupProgress.groups.find(item => item.key === row.key))), sessionProvider, checkpoint })
    if (report.deletion?.status !== 'deleted' || report.deletion.signedOut !== true) fail('cleanup_delete_pending')
    report.status = 'deleted'
  } catch (error) { report.status = 'failed'; report.error = safeError(error) }
  report.signedOut = signedOut(requests); report.finishedAt = new Date().toISOString(); checkpointNow()
  return report
}

/** Recovery after the deletion helper attempted its one write but could not
 * confirm the result. This entry can only read absence; it cannot delete again. */
export async function verifyFinalDeletion(evidence, previous, { sessionProvider = alexSession, checkpoint = true } = {}) {
  validateCleanupEvidence(evidence)
  if (!evidence.manifest.allCasesCompleted || previous?.phase !== 'alex-final-workspace-cleanup' ||
    previous.evidenceSha256 !== evidence.manifestSha256 || previous.workspaceId !== CLEANUP_SCOPE.workspaceId ||
    previous.ownerRef !== ref(ALEX_OWNER_ID) || previous.deletion?.deleteAttempts !== 1) fail('cleanup_progress_invalid')
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-final-deletion-verification', status: 'failed',
    workspaceId: CLEANUP_SCOPE.workspaceId, ownerRef: ref(ALEX_OWNER_ID), evidenceSha256: evidence.manifestSha256,
    startedAt: new Date().toISOString(), deleteAttempts: 0, absenceReads: 0, requests: [] }
  let requests = []
  try {
    await sessionProvider(async session => {
      requests = session.requests
      if (session.identity?.userId !== ALEX_OWNER_ID) fail('cleanup_evidence_scope')
      if (!SHA.test(session.version?.build ?? '')) fail('acceptance_version_mismatch')
      report.applicationSha = session.version?.build
      report.absenceReads++
      const after = await readJson(session, '/api/workspace/switcher')
      const account = after.accounts?.find(row => row.id === ALEX_OWNER_ID)
      if (!Array.isArray(account?.choices)) fail('cleanup_delete_pending')
      if (account.choices.some(row => row.id === CLEANUP_SCOPE.workspaceId)) fail('cleanup_delete_pending')
      report.absentFromOwnerWorkspaceChoices = true; report.status = 'deleted'
    }, { expectedSha: null, deadlineAt: Date.now() + 60_000 })
    if (!signedOut(requests)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = safeError(error) }
  report.signedOut = signedOut(requests); report.requests = requestMetadata(requests); report.finishedAt = new Date().toISOString()
  save(report, checkpoint); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, manifestPath, progressPath] = process.argv.slice(2), evidence = loadCleanupEvidence(manifestPath)
    let report
    if (mode === 'validate') report = { issue: 1506, phase: 'alex-final-cleanup-evidence', status: 'ready', evidenceSha256: evidence.manifestSha256, inventory: cleanupInventory(evidence) }
    else if (mode === 'groups') report = await cleanupGroups(evidence, { previous: progressPath ? readFile(progressPath, 150_000).value : null })
    else if (mode === 'workspace' && progressPath) report = await cleanupFinalWorkspace(evidence, readFile(progressPath, 150_000).value)
    else if (mode === 'verify-deletion' && progressPath) report = await verifyFinalDeletion(evidence, readFile(progressPath, 200_000).value)
    else fail('cleanup_input_invalid')
    console.log(JSON.stringify(report)); if (!['ready', 'complete', 'deleted'].includes(report.status)) process.exitCode = 1
  } catch (error) { console.log(JSON.stringify({ issue: 1506, phase: 'alex-final-cleanup', status: 'failed', error: safeError(error) })); process.exitCode = 1 }
}
