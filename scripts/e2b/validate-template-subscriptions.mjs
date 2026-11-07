#!/usr/bin/env node
/** Candidate-image release gate. All credentials stay in memory or the
 * disposable instance's private stdin file, never in the template/report. */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { runCloudStartup, createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace, acceptanceBot } from '../acceptance/cloud-startup.mjs'
import { readRuntimeTiming, runtimeEvidence } from '../acceptance/cloud-startup-evidence.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const KINDS = [['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']]
const fail = (code, cause) => { throw Error(`template_gate_${code}`, cause ? { cause } : undefined) }
const check = (value, code) => { if (!value) fail(code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const GATE_CODES = new Set([
  'source_invalid', 'source_mismatch', 'account_required', 'fixtures_required', 'application_build_mismatch',
  'sign_in_failed', 'account_mismatch', 'candidate_invalid', 'candidate_worker_mismatch', 'enrollment_failed',
  'registration_timeout', 'registration_output_invalid', 'daemon_exited', 'daemon_failed', 'registration_invalid',
  'registered_agent_missing', 'execution_failed', 'execution_evidence_invalid', 'official_agent_acceptance_missing', 'tool_reply_evidence_missing',
  'device_cleanup_failed', 'sandbox_cleanup_failed', 'application_build_changed', 'sign_out_failed',
  'subscription_or_cleanup_failed', 'subscriptions_missing', 'paths_required', 'workspace_restore_failed', 'shared_scope_evidence_invalid',
].map(code => `template_gate_${code}`))
const STARTUP_CODES = new Set([
  'dispatch_refused', 'dispatch_run_missing', 'dispatch_not_new', 'dispatch_device_mismatch',
  'subscription_provenance_mismatch', 'execution_device_mismatch', 'execution_timeout', 'ended_before_execution_proof',
  'official_agent_acceptance_missing', 'runtime_evidence_failed', 'live_disconnected', 'live_scope_missing',
  'request_failed', 'response_invalid', 'build_mismatch', 'build_changed',
  'cleanup_terminal_timeout',
  'shared_subscription_identity_mismatch', 'shared_subscription_model_missing_or_ambiguous',
  'shared_chat_model_ambiguous', 'shared_chat_model_unavailable', 'workspace_identity_mismatch', 'profile_source_mismatch',
].map(code => `startup_${code}`))
const safeCode = error => GATE_CODES.has(error?.message) || STARTUP_CODES.has(error?.message) ? error.message : 'template_gate_failed'
const SAMPLE_STATUSES = new Set(['running', 'failed', 'execution_proved_awaiting_server_timing'])

function candidateDiagnostic(kind, stage, error, acceptance, cleanupErrors, deviceId) {
  const sample = acceptance?.samples?.[0]
  const cleanup = new Set(cleanupErrors)
  if (acceptance?.cleanup?.errors?.length || sample?.cleanup?.errors?.length || sample?.cleanup?.status === 'failed') cleanup.add('acceptance_cleanup_failed')
  if (sample?.cleanup?.errors?.some(row => row?.code === 'startup_cleanup_terminal_timeout')) cleanup.add('terminal_timeout')
  const retained = sample?.cleanup?.retainedFixture
  const retainedRunIds = Array.isArray(retained?.runIds) ? [...new Set(retained.runIds.map(id => typeof id === 'string' ? id.toLowerCase() : id))] : []
  const retainedFixture = UUID.test(retained?.issueId ?? '') && retained.issueId === sample.issueId
    && retainedRunIds.length > 0 && retainedRunIds.length <= 4 && retainedRunIds.every(id => typeof id === 'string' && UUID.test(id))
    ? { issueId: retained.issueId, runIds: retainedRunIds } : undefined
  return { kind, stage, code: error ? safeCode(error) : 'passed',
    runIdHash: UUID.test(sample?.runId ?? '') ? createHash('sha256').update(sample.runId).digest('hex').slice(0, 16) : null,
    sampleStatus: SAMPLE_STATUSES.has(sample?.status) ? sample.status : 'unavailable',
    sampleError: sample?.error ? STARTUP_CODES.has(sample.error) ? sample.error : 'startup_failed' : null,
    cleanupErrors: [...cleanup], ...(retainedFixture ? { retainedFixture } : {}),
    ...(cleanup.has('device_remove_failed') && UUID.test(deviceId ?? '') ? { registeredDeviceId: deviceId } : {}) }
}

export function candidateReceipt(report, kind, proof, acceptance, expectedScope) {
  const [, harness, model] = KINDS.find(row => row[0] === kind)
  const sample = acceptance.samples?.[0]
  check(acceptance.mode === 'candidate' && acceptance.status === 'candidate_subscription_proved' && acceptance.samples?.length === 1 && !acceptance.error
    && !acceptance.cleanup?.errors?.length && sample?.status === 'execution_proved_awaiting_server_timing'
    && sample.cleanup?.status === 'passed', 'execution_failed')
  check(sample.harness === harness && sample.execution?.harness === harness && sample.execution?.model === model
    && sample.execution?.deviceId === proof.deviceId && sample.execution?.credentialType === 'subscription'
    && sample.credentialRoute === 'subscription' && sample.replyVerified === true
    && sample.sourceCommit === report.sourceCommit && UUID.test(sample.runId ?? ''), 'execution_evidence_invalid')
  const scope = sample.execution.sharedScope
  check(scope?.verified === true && scope.access === 'workspace_share' && acceptance.team?.teamWorkspaceConfirmed === true
    && acceptance.team.teamAdminMembershipVerified === true && acceptance.cleanup.workspaceRestored === true
    && /^[a-f0-9]{64}$/.test(scope.workspaceHash ?? '') && scope.workspaceHash === acceptance.team.teamWorkspaceHash
    && ['requesterHash', 'payerHash', 'connectionHash', 'bindingHash'].every(key => /^[a-f0-9]{16}$/.test(scope[key] ?? ''))
    && scope.requesterHash === acceptance.accountHash && scope.requesterHash !== scope.payerHash
    && /^(0|[1-9][0-9]*)$/.test(scope.connectionRevision ?? '')
    && Number.isInteger(scope.profileVersion) && scope.profileVersion > 0 && /^[a-f0-9]{64}$/.test(scope.profileDigest ?? '')
    && (!expectedScope || scope.workspaceHash === expectedScope.evidence.teamWorkspaceHash
      && scope.requesterHash === createHash('sha256').update(expectedScope.ownerId).digest('hex').slice(0, 16)
      && scope.payerHash === createHash('sha256').update(expectedScope.adminId).digest('hex').slice(0, 16)), 'shared_scope_evidence_invalid')
  const tool = Array.isArray(sample.toolCalls) && sample.toolCalls.find(row => row?.outcome === 'ok' && /^[a-f0-9]{16}$/.test(row.toolCallHash ?? ''))
  check(sample.minToolCalls === 1 && sample.requireReplyAfterTool === true && sample.replyVerifiedAfterTool === true && tool, 'tool_reply_evidence_missing')
  const runIdHash = createHash('sha256').update(sample.runId).digest('hex').slice(0, 16)
  const runtime = readRuntimeTiming(sample.runtimeTiming, { runIdHash, harness })
  const authorization = runtimeEvidence(runtime)
  check(sample.requireAgentAcceptance === true && runtime?.complete === true && runtime.truncated === false
    && runtime.agentAccepted?.kind === (harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack')
    && authorization.status === 'passed', 'official_agent_acceptance_missing')
  return { status: 'passed', templateId: report.templates[kind].templateId, sourceCommit: report.sourceCommit,
    workerSha: report.workerSha, harness, model, credentialRoute: 'subscription', replyVerified: true,
    replyVerifiedAfterTool: true, toolEvidence: { toolCallHash: tool.toolCallHash, outcome: 'ok' },
    runId: sample.runId, deviceId: proof.deviceId, officialBinarySha256: proof.binarySha256,
    officialCliVersion: proof.version,
    sharedScope: { verified: true, access: 'workspace_share', requesterHash: scope.requesterHash, payerHash: scope.payerHash,
      workspaceHash: scope.workspaceHash, connectionHash: scope.connectionHash, bindingHash: scope.bindingHash,
      connectionRevision: scope.connectionRevision, profileVersion: scope.profileVersion, profileDigest: scope.profileDigest },
    agentAcceptance: { runIdHash, harness, ...runtime.agentAccepted },
    runtimeAuthorization: { source: runtime.source, complete: true, truncated: false, extraRemoteCalls: authorization.extraRemoteCalls } }
}

export async function validateTemplateSubscriptions(report, { env = process.env, fetchImpl = fetch,
  sandboxFactory, runAcceptance = runCloudStartup, onDiagnostic = () => {} } = {}) {
  check(/^[a-f0-9]{40}$/.test(report.sourceCommit ?? '') && /^[a-f0-9]{40}$/.test(report.workerSha ?? ''), 'source_invalid')
  check(!env.GITHUB_SHA || env.GITHUB_SHA === report.sourceCommit, 'source_mismatch')
  let account
  try { account = smokeAcceptanceAccount(env) } catch { fail('account_required') }
  check((!env.MIKKA_ACCEPTANCE_WORKSPACE_ID || UUID.test(env.MIKKA_ACCEPTANCE_WORKSPACE_ID))
    && (!env.MIKKA_ACCEPTANCE_BOT_ID || UUID.test(env.MIKKA_ACCEPTANCE_BOT_ID)), 'fixtures_required')
  const origin = 'https://app.aspectlylabs.com', client = createSessionClient(origin, fetchImpl)
  if (!sandboxFactory) {
    const { Sandbox } = await import('e2b')
    sandboxFactory = (template, options) => Sandbox.create(template, options)
  }
  const passed = {}, failures = []
  let loggedIn = false, originalWorkspaceId, ownerId, scope, bot, fatal, workspaceRestored = false
  try {
    const version = await client.json('/api/version')
    check(version.build === report.sourceCommit, 'application_build_mismatch')
    const login = await client.request('/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    check(login.ok, 'sign_in_failed'); loggedIn = true
    const identity = await client.json('/api/auth/get-session')
    check(identity.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof identity.user.id === 'string' && identity.user.id.length > 0, 'account_mismatch')
    ownerId = identity.user.id
    scope = await selectAcceptanceTeam(client, { ownerId, workspace: env.MIKKA_ACCEPTANCE_WORKSPACE_ID }, value => { originalWorkspaceId = value })
    bot = await acceptanceBot(client, env.MIKKA_ACCEPTANCE_BOT_ID, randomUUID())
    for (const [kind, harness] of KINDS) {
      let sandbox, deviceId, acceptance, diagnosticError, enrollmentIssued = false, stage = 'candidate'
      const cleanupErrors = []
      try {
        const template = report.templates?.[kind]
        check(template?.baseTemplate === kind && template?.preinstalled === true && /^[A-Za-z0-9_-]+$/.test(template?.templateId ?? ''), 'candidate_invalid')
        sandbox = await sandboxFactory(template.templateId, { apiKey: env.E2B_API_KEY, timeoutMs: 600000,
          metadata: { application: 'mikka-template-release', sourceCommit: report.sourceCommit, kind,
            runId: env.GITHUB_RUN_ID ?? 'manual', runAttempt: env.GITHUB_RUN_ATTEMPT ?? 'manual' } })
        stage = 'worker'
        const installed = await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
        check(installed.trim() === report.workerSha, 'candidate_worker_mismatch')
        stage = 'enrollment'
        const grant = await client.json('/api/devices/enrollment', post({}))
        check(typeof grant.token === 'string', 'enrollment_failed')
        enrollmentIssued = true
        await sandbox.commands.run('install -d -m 700 /run/mikka-template-acceptance', { user: 'root', timeoutMs: 10000 })
        await sandbox.files.write('/run/mikka-template-acceptance/enrollment', grant.token, { user: 'root' })
        stage = 'registration'
        let resolveReady, rejectReady, buffer = ''
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
        const timer = setTimeout(() => rejectReady(Error('template_gate_registration_timeout')), 90000)
        try {
          const process = await sandbox.commands.run(
            'cat /run/mikka-template-acceptance/enrollment | runuser -u user -- env PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin ' +
            `MIKKA_ACCEPTANCE_ORIGIN=${origin} MIKKA_ACCEPTANCE_HARNESS=${harness} ` +
            '/opt/mikka/worker/packages/daemon/node_modules/.bin/tsx /opt/mikka/worker/scripts/e2b/acceptance-daemon.mts', {
              user: 'root', background: true, timeoutMs: 0, onStdout: text => {
                buffer += text
                if (buffer.length > 65536) { rejectReady(Error('template_gate_registration_output_invalid')); return }
                const match = /^mikka-template-device (\{[^\r\n]+\})$/m.exec(buffer)
                if (match) { try { resolveReady(JSON.parse(match[1])) } catch (error) { rejectReady(Error('template_gate_registration_output_invalid', { cause: error })) } }
              }, onStderr: () => {},
            })
          void process.wait().then(() => rejectReady(Error('template_gate_daemon_exited')), error => rejectReady(Error('template_gate_daemon_failed', { cause: error })))
          const proof = await ready
          check(UUID.test(proof.deviceId ?? '') && proof.harness === harness && /^[a-f0-9]{64}$/.test(proof.binarySha256 ?? ''), 'registration_invalid')
          deviceId = proof.deviceId
          stage = 'agents'
          const agents = await client.rpc('agents.listAgents', [])
          const matching = agents.filter(agent => agent.deviceId === deviceId && agent.harness === harness)
          check(matching.length === 1, 'registered_agent_missing')
          stage = 'acceptance'
          acceptance = await runAcceptance({ origin, workspace: scope.workspaceId,
            botId: bot.botId, mode: 'candidate', strategy: 'derived', runs: 1, harness,
            deviceId, agentId: matching[0].id, revision: report.sourceCommit, expectedBuild: version.build,
            timeoutMs: 240000, maxStartupMs: 5000, minToolCalls: 1 }, { env, fetchImpl })
          stage = 'receipt'
          passed[kind] = candidateReceipt(report, kind, proof, acceptance, scope)
        } finally { clearTimeout(timer) }
      } catch (error) { diagnosticError = error; failures.push({ kind, error }) }
      finally {
        // If registration succeeded but its stream response was lost, recover
        // only this instance's locally recorded proof before revoking it.
        if (!deviceId && sandbox && enrollmentIssued) {
          try {
            const proof = JSON.parse(await sandbox.files.read('/home/user/.mikka/template-acceptance/device-proof.json', { user: 'root' }))
            if (UUID.test(proof.deviceId ?? '') && proof.harness === harness) deviceId = proof.deviceId
          } catch { /* No successful registration may have been recorded. */ }
        }
        if (deviceId) {
          try { await client.rpc('agents.removeDevice', [deviceId]) }
          catch (error) {
            const failure = Error('template_gate_device_cleanup_failed', { cause: error })
            failures.push({ kind, error: failure }); cleanupErrors.push('device_remove_failed')
            if (!diagnosticError) { diagnosticError = failure; stage = 'cleanup' }
          }
        }
        if (sandbox) {
          try { await sandbox.kill() }
          catch (error) {
            const failure = Error('template_gate_sandbox_cleanup_failed', { cause: error })
            failures.push({ kind, error: failure }); cleanupErrors.push('sandbox_kill_failed')
            if (!diagnosticError) { diagnosticError = failure; stage = 'cleanup' }
          }
        }
        onDiagnostic(candidateDiagnostic(kind, stage, diagnosticError, acceptance, cleanupErrors, deviceId))
      }
    }
    check((await client.json('/api/version')).build === version.build, 'application_build_changed')
  } catch (error) { fatal = error }
  finally {
    if (loggedIn) {
      if (originalWorkspaceId) {
        try { await restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId); workspaceRestored = true }
        catch (error) { failures.push({ error: Error('template_gate_workspace_restore_failed', { cause: error }) }) }
      }
      try { const logout = await client.request('/api/auth/sign-out', post({})); check(logout.ok, 'sign_out_failed') }
      catch (error) { failures.push({ error: Error('template_gate_sign_out_failed', { cause: error }) }) }
    }
    client.clear()
  }
  if (fatal) throw fatal
  if (failures.length) fail('subscription_or_cleanup_failed', new AggregateError(failures.map(row => row.error)))
  check(KINDS.every(([kind]) => passed[kind]), 'subscriptions_missing')
  return { ...report, acceptanceScope: { account: 'shared_smoke', team: scope.evidence, workspaceRestored,
    requesterHash: createHash('sha256').update(scope.ownerId).digest('hex').slice(0, 16),
    payerHash: createHash('sha256').update(scope.adminId).digest('hex').slice(0, 16),
    botRetention: bot.retention, createdBotCount: Number(bot.created) }, subscriptionAcceptance: passed }
}

/** The failure artifact is a closed projection, never an exception/report dump. */
export async function validateSubscriptionFiles(input, output, diagnosticsPath, options = {}) {
  const diagnostics = { version: 1, status: 'running', code: null, candidates: [] }
  try {
    check(input && output && diagnosticsPath, 'paths_required')
    const result = await validateTemplateSubscriptions(JSON.parse(await readFile(input, 'utf8')), {
      ...options, onDiagnostic: row => { diagnostics.candidates.push(row) },
    })
    await writeFile(output, `${JSON.stringify(result)}\n`, { mode: 0o600 })
    diagnostics.status = 'passed'
    return result
  } catch (error) {
    diagnostics.status = 'failed'; diagnostics.code = safeCode(error)
    throw error
  } finally {
    if (diagnosticsPath) await writeFile(diagnosticsPath, `${JSON.stringify(diagnostics)}\n`, { mode: 0o600 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [input, output, diagnosticsPath = `${output}.diagnostics.json`] = process.argv.slice(2)
    check(input && output, 'paths_required')
    await validateSubscriptionFiles(input, output, diagnosticsPath)
    console.log('Both candidate images passed real official subscription execution and cleanup')
  } catch (error) {
    console.error(safeCode(error))
    process.exitCode = 1
  }
}
