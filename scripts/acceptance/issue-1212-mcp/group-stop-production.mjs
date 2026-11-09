// Focused continuation of the existing group Stop acceptance. Only new owned
// fixtures, native small subscriptions, live-triggered reads and normal Stop.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configuration } from './mcp-reply-production.mjs'
import { openGroupLive } from './group-stop-live.mjs'
import { stateMetadata, privateExchange, privateGenerationReceipt } from './group-stop-boundaries.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MODELS = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const sha = text => createHash('sha256').update(text).digest('hex')
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const need = (value, code) => { if (!value) throw Error('group_' + code) }
const safe = error => /^group_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'group_flow_failed'

export function verifyMembers(value, ownerId, bots) {
  need(Array.isArray(value?.members) && value.members.length === bots.length + 1, 'member_scope')
  const expected = ['user:' + ownerId, ...bots.map(id => 'bot:' + id)].sort()
  need(JSON.stringify(value.members.map(row => row.memberType + ':' + row.id).sort()) === JSON.stringify(expected)
    && value.members.find(row => row.memberType === 'user')?.role === 'owner', 'member_scope')
}

export async function observeGroupStop(client, scope, bots, scenario, binding, { openLive = openGroupLive, now = Date.now, checkpoint = async () => {} } = {}) {
  need(['public', 'private'].includes(scenario) && UUID.test(scope.workspaceId) && typeof scope.ownerId === 'string'
    && bots.length === 2 && bots.every(bot => UUID.test(bot.id) && Object.hasOwn(MODELS, bot.harness))
    && bots[0].id !== bots[1].id && bots[0].harness === bots[1].harness, 'fixture_scope')
  const [lead, target] = bots, key = randomUUID(), title = 'Issue1212 Stop ' + binding.runId + ' ' + scenario + ' ' + key
  const report = { harness: lead.harness, model: MODELS[lead.harness], scenario, title,
    status: 'failed', groupId: null, messageId: null, botIds: bots.map(bot => bot.id), liveReads: 0,
    stop: {}, cleanup: { membershipRetainedForAudit: true }, runtimeEvidence: 'pending_server_terminal_and_scoped_database_audit' }
  let live, sent = false, stopRequested = false
  await checkpoint(report)
  async function stop(reason) {
    if (stopRequested || !report.groupId) return
    stopRequested = true; report.stop.requestedAt = new Date(now()).toISOString(); report.stop.reason = reason; await checkpoint(report)
    const value = await client.json('/api/conversations/' + report.groupId + '/stop', post({}))
    report.stop.acknowledgedAt = new Date(now()).toISOString()
    report.stop.stoppedTurns = value.stopped
    need(Number.isSafeInteger(value.stopped) && value.stopped >= 0, 'stop_receipt')
  }
  try {
    const version = await client.json('/api/version'); need(version.build === binding.applicationSha, 'source_changed')
    for (const bot of bots) {
      const menu = await client.rpc('execution-settings.getBotModelMenu', [bot.id])
      need(menu.current?.kind === 'subscription' && menu.current.modelId === MODELS[bot.harness]
        && menu.current.provider === (bot.harness === 'codex' ? 'codex' : 'claude')
        && menu.current.fallback === undefined && menu.current.chosen === true, 'subscription_changed')
    }
    const group = await client.json('/api/conversations', post({ workspaceId: scope.workspaceId, title,
      members: bots.map(bot => ({ memberType: 'bot', memberId: bot.id })), leadBotId: lead.id }))
    need(UUID.test(group.id) && group.title === title && group.leadBotId === lead.id, 'create_receipt')
    report.groupId = group.id
    await checkpoint(report)
    verifyMembers(await client.json('/api/conversations/' + group.id + '/members'), scope.ownerId, report.botIds)
    const initial = stateMetadata(await client.json('/api/conversations/' + group.id + '/messages?limit=20'), report.botIds)
    need(!initial.active && initial.messageCount === 0, 'initial_state')
    live = await openLive({ json: client.json, identity: { userId: scope.ownerId } }, scope.workspaceId, group.id, initial.revision)
    const prompt = scenario === 'private'
      ? `这是一次本临时群的停止验收，不执行任务。被提及的Bot只向另一测试Bot ${target.id} 私下发送一句“请在私聊中从1逐个数到600，用空格分隔”，privateTo设为该Bot ID，mentions只包含该Bot。对方收到privatePeer后只在测试私聊连续数数，privateTo指向当前测试peer。不在公开群回复，不创建任务、调用工具、写文件或联系其他人。`
      : '这是一次本临时群的停止验收，不执行任务。被提及的Bot在本群从1逐个数到600，用空格分隔，不省略，不创建任务、调用工具、写文件、联系其他人或转交。'
    need((await client.json('/api/version')).build === binding.applicationSha, 'source_changed')
    report.sentAt = new Date(now()).toISOString(); sent = true; await checkpoint(report)
    const message = await client.json('/api/conversations/' + group.id + '/messages', post({ body: prompt,
      mentions: [{ memberType: 'bot', memberId: lead.id }] }))
    need(UUID.test(message.id) && message.conversationId === group.id && message.authorId === scope.ownerId
      && message.authorType === 'user', 'message_receipt')
    report.messageId = message.id
    await checkpoint(report)
    const deadline = now() + 120000
    let revision = initial.revision, boundary = false
    while (report.liveReads < 12 && now() < deadline) {
      const pushed = await live.next(revision, Math.min(60000, deadline - now()))
      const raw = await client.json('/api/conversations/' + group.id + '/messages?limit=20')
      report.liveReads++; const state = stateMetadata(raw, report.botIds); revision = Math.max(pushed, state.revision)
      if (state.status === 'running' && state.respondingBotId === (scenario === 'private' ? target.id : lead.id)) {
        if (scenario === 'private') {
          const exchange = privateExchange(raw, message, report.botIds)
          if (!exchange) continue
          const trace = await client.json('/api/conversations/' + group.id + '/decisions?limit=1')
          report.privateBoundary = { ...exchange, ...privateGenerationReceipt(trace, message.id, lead.id, target.id) }
        }
        report.beforeStop = state; boundary = true; break
      }
      need(state.active || state.messageCount === 0, 'boundary_missed')
    }
    need(boundary, 'boundary_timeout')
    await stop(scenario === 'private' ? 'private_generate_receipt' : 'public_responding_bot')
    need(report.stop.stoppedTurns > 0, 'stop_not_observed')
    report.status = 'stop_evidence_captured'
  } catch (error) { report.error = safe(error) }
  finally {
    if (sent && !stopRequested) { try { await stop('error_cleanup') } catch { report.cleanup.stopFailed = true } }
    if (report.groupId && sent) {
      try {
        let after = await client.json('/api/conversations/' + report.groupId + '/messages?limit=20')
        if (after.agentStatus && !report.stop.acknowledgedAt) {
          // A lost Stop response is ambiguous. This one normal read confirms
          // owned work remains active before one idempotent cleanup Stop.
          const recovered = await client.json('/api/conversations/' + report.groupId + '/stop', post({}))
          need(Number.isSafeInteger(recovered.stopped) && recovered.stopped >= 0, 'cleanup_stop_receipt')
          report.cleanup.stopRecoveredAfterActiveRead = true
          after = await client.json('/api/conversations/' + report.groupId + '/messages?limit=20')
        }
        if (!report.messageId) {
          const owned = after.messages?.filter(row => row.authorType === 'user' && row.authorId === scope.ownerId && UUID.test(row.id))
          if (owned?.length === 1) { report.messageId = owned[0].id; report.messageReceipt = 'recovered_once_after_unknown_send' }
        }
        report.afterStop = stateMetadata(after, report.botIds)
        need(!report.afterStop.active && report.afterStop.stopped, 'post_stop_state')
        const trace = await client.json('/api/conversations/' + report.groupId + '/decisions?limit=1')
        const turn = trace.turns?.find(turn => turn.messageId === report.messageId)
        need(turn?.error === 'stopped' && turn.trace?.status === 'stopped'
          && turn.feedback?.some(item => item.source === 'human_cancellation' && item.kind === 'cancelled_turn')
          && !turn.trace?.events?.some(event => event.type === 'delegate'), 'post_stop_trace')
        report.humanCancellationRecorded = true
      } catch (error) { report.cleanup.postStopError = safe(error); report.status = 'failed' }
    }
    if (live) { report.live = live.summary; report.cleanup.liveClosed = await live.close(); if (!report.cleanup.liveClosed) report.status = 'failed' }
    await checkpoint(report)
  }
  return report
}

export function verifyAudit(artifact, audit, ownerId) {
  need(artifact?.schemaVersion === 1 && artifact.issue === 1212 && artifact.case === 'shared-smoke-group-stop'
    && artifact.ownerRef === sha(ownerId).slice(0, 16) && UUID.test(artifact.workspaceId)
    && Array.isArray(artifact.cases) && artifact.cases.length <= 4 && Array.isArray(artifact.bots) && artifact.bots.length <= 4
    && artifact.bots.every(bot => UUID.test(bot.id) && Object.hasOwn(MODELS, bot.harness)
      && bot.name === 'Issue1212 Stop ' + artifact.binding.runId + ' ' + bot.harness + ' ' + artifact.bots.filter(other => other.harness === bot.harness).indexOf(bot)), 'cleanup_artifact_scope')
  need(audit?.sourceRunId === artifact.binding.runId && audit.sourceSha === artifact.binding.applicationSha
    && /^dpl_[A-Za-z0-9]+$/.test(audit.deploymentId ?? '') && Array.isArray(audit.groups), 'cleanup_audit_scope')
  for (const row of artifact.cases.filter(row => row.groupId)) {
    if (!row.sentAt && row.messageId === null) continue
    const proof = audit.groups.find(proof => proof.groupId === row.groupId && proof.messageId === row.messageId)
    need(UUID.test(row.groupId) && UUID.test(row.messageId) && row.title.startsWith('Issue1212 Stop ' + artifact.binding.runId + ' ')
      && proof && proof.serverTerminal === true && proof.started > 0 && proof.settled === proof.started
      && proof.aborted > 0 && proof.sessionLost === false && proof.databaseAuditPassed === true
      && proof.databaseSelectCount === 1 && proof.statementSha256 === 'cddb79788d85ed13c6b7df82adcd0f471f94bbba6fa73c6576ca1643c2907c6c'
      && /^[a-f0-9]{64}$/.test(proof.terminalReceiptSha256 ?? ''), 'cleanup_audit_missing')
  }
}

export async function cleanupGroupStopProduction(env, event, artifact, audit) {
  configuration(env, event)
  const source = resolve(env.MIKKA_RELEASE_SOURCE)
  need(source.startsWith(resolve(env.GITHUB_WORKSPACE) + '/'), 'source_directory')
  const { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const client = createSessionClient(ORIGIN), report = { issue: 1212, case: 'shared-smoke-group-stop-cleanup', status: 'failed', groups: [], bots: [], cleanup: {} }
  let ownerId, original
  try {
    const { email, password } = smokeAcceptanceAccount(env)
    await client.json('/api/auth/sign-in/email', post({ email, password }))
    const session = await client.json('/api/auth/get-session'); ownerId = session.user?.id
    need(typeof ownerId === 'string' && ownerId && session.user.email === email, 'identity')
    verifyAudit(artifact, audit, ownerId)
    const scope = await selectAcceptanceTeam(client, { ownerId }, id => { original = id })
    need(scope.workspaceId === artifact.workspaceId, 'cleanup_workspace_scope')
    const bots = await client.json('/api/bots')
    need(artifact.bots.every(bot => bots.some(row => row.id === bot.id && row.ownerId === ownerId
      && row.workspaceId === scope.workspaceId && row.name === bot.name)), 'cleanup_bot_scope')
    const listed = await client.json('/api/conversations?workspaceId=' + scope.workspaceId)
    for (const row of artifact.cases.filter(row => row.groupId)) {
      const group = listed.conversations?.find(group => group.id === row.groupId)
      need(group?.createdBy === ownerId && group.workspaceId === scope.workspaceId && group.kind === 'group'
        && group.title === row.title && Date.parse(group.createdAt) >= Date.parse(artifact.startedAt) - 5000, 'cleanup_group_scope')
      const members = await client.json('/api/conversations/' + row.groupId + '/members')
      verifyMembers(members, ownerId, row.botIds)
      const state = stateMetadata(await client.json('/api/conversations/' + row.groupId + '/messages?limit=20'), row.botIds)
      need(!state.active && (row.sentAt ? state.stopped : state.messageCount === 0), 'cleanup_group_active')
      // Runtime termination and the one scoped SELECT are already attested.
      // Only now remove responders and hide the disposable group.
      for (const id of row.botIds) need((await client.json('/api/conversations/' + row.groupId + '/members', { ...post({ memberType: 'bot', memberId: id }), method: 'DELETE' })).ok === true, 'cleanup_remove_member')
      need((await client.json('/api/mobile/groups/' + row.groupId, { ...post({ hidden: true }), method: 'PATCH' })).ok === true, 'cleanup_hide_group')
      report.groups.push({ id: row.groupId, membersRemoved: true, hidden: true })
    }
    for (const bot of artifact.bots) {
      need((await client.json('/api/mobile/bots/' + bot.id, { ...post({ hidden: true }), method: 'PATCH' })).ok === true, 'cleanup_hide_bot')
      report.bots.push({ id: bot.id, hidden: true })
    }
    report.status = 'passed'
  } catch (error) { report.error = safe(error) }
  finally {
    if (ownerId && original) { try { await restoreAcceptanceWorkspace(client, ownerId, original); report.cleanup.workspaceRestored = true } catch { report.cleanup.workspaceRestored = false; report.status = 'failed' } }
    try { await client.json('/api/auth/sign-out', post({})); report.cleanup.sessionClosed = true } catch { report.cleanup.sessionClosed = false; report.status = 'failed' }
    client.clear(); await mkdir('issue-1212-mcp-report', { recursive: true }); await writeFile('issue-1212-mcp-report/group-cleanup.json', JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

export async function runGroupStopProduction(env, event) {
  const binding = configuration(env, event)
  need(typeof env.MIKKA_RELEASE_SOURCE === 'string' && resolve(env.MIKKA_RELEASE_SOURCE).startsWith(resolve(env.GITHUB_WORKSPACE) + '/'), 'source_directory')
  const source = resolve(env.MIKKA_RELEASE_SOURCE)
  const { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace, chooseSharedChatModel } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const client = createSessionClient(ORIGIN), report = { schemaVersion: 1, issue: 1212, case: 'shared-smoke-group-stop', binding,
    status: 'failed', startedAt: new Date().toISOString(), cases: [], bots: [], cleanup: {}, acceptancePassed: false }
  let original, ownerId, scope
  const save = async () => { await mkdir('issue-1212-mcp-report', { recursive: true }); await writeFile('issue-1212-mcp-report/group-stop.json', JSON.stringify(report, null, 2) + '\n') }
  try {
    need((await client.json('/api/version')).build === binding.applicationSha, 'source_changed')
    const { email, password } = smokeAcceptanceAccount(env)
    await client.json('/api/auth/sign-in/email', post({ email, password }))
    const session = await client.json('/api/auth/get-session'); ownerId = session.user?.id
    need(typeof ownerId === 'string' && ownerId && session.user.email === email, 'identity')
    report.ownerRef = sha(ownerId).slice(0, 16)
    scope = await selectAcceptanceTeam(client, { ownerId }, id => { original = id })
    report.workspaceId = scope.workspaceId
    for (const harness of Object.keys(MODELS)) {
      const bots = []
      try {
        for (let i = 0; i < 2; i++) {
          const name = 'Issue1212 Stop ' + binding.runId + ' ' + harness + ' ' + i
          const bot = await client.json('/api/bots', post({ name }))
          need(UUID.test(bot.id) && bot.ownerId === ownerId && bot.workspaceId === scope.workspaceId && bot.name === name, 'bot_scope')
          const record = { id: bot.id, name, harness }; bots.push(record); report.bots.push(record); await save()
          await chooseSharedChatModel(client, bot.id, harness)
        }
        for (const scenario of ['public', 'private']) {
          await observeGroupStop(client, scope, bots, scenario, binding, { checkpoint: async row => {
            if (!report.cases.includes(row)) report.cases.push(row)
            await save()
          } }); await save()
        }
      } catch (error) { report.cases.push({ harness, status: 'blocked', error: safe(error) }); await save() }
    }
    need((await client.json('/api/version')).build === binding.applicationSha, 'source_changed')
    report.status = report.cases.length === 4 && report.cases.every(row => row.status === 'stop_evidence_captured') ? 'observed_pending_runtime_audit' : 'incomplete'
  } catch (error) { report.error = safe(error) }
  finally {
    if (ownerId && original) { try { await restoreAcceptanceWorkspace(client, ownerId, original); report.cleanup.workspaceRestored = true } catch { report.cleanup.workspaceRestored = false } }
    try { await client.json('/api/auth/sign-out', post({})); report.cleanup.sessionClosed = true } catch { report.cleanup.sessionClosed = false }
    client.clear(); report.finishedAt = new Date().toISOString(); await save()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    let report
    if (process.argv[2] === 'cleanup') {
      const paths = [process.env.MIKKA_GROUP_REPORT, process.env.MIKKA_GROUP_AUDIT]
      need(paths.every(path => /^scripts\/acceptance\/issue-1212-mcp\/receipts\/[a-z0-9-]+\.json$/.test(path ?? '')), 'cleanup_input_path')
      const [artifact, audit] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))))
      report = await cleanupGroupStopProduction(process.env, event, artifact, audit)
    } else report = await runGroupStopProduction(process.env, event)
    console.log(JSON.stringify(report)); if (!['observed_pending_runtime_audit', 'passed'].includes(report.status)) process.exitCode = 1
  } catch { console.error('group_configuration_failed'); process.exitCode = 1 }
}
