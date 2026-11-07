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
const RUN_STATUSES = new Set(['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing', 'succeeded', 'completed', 'stopped', 'failed', 'cancelled'])
const TIMING_STATUSES = new Set(['unavailable', 'invalid', 'incomplete', 'truncated', 'complete'])
const duration = value => Number.isFinite(value) && value >= 0 && value <= 3_600_000
const CLEANUP_STEPS = new Map([['factoryCancelled', 'factory_cancel'], ['taskDeleted', 'task_delete'],
  ...['profile_archive', 'timing_variable_delete', 'stop_test_bot', 'workspace_restore', 'sign_out', 'device_remove', 'sandbox_kill'].map(step => [step, step])])
const CLEANUP_CODES = new Set(['startup_cleanup_scope_mismatch', 'startup_factory_list_invalid',
  'startup_api_refused', 'startup_rpc_refused', 'startup_action_refused', 'startup_workspace_restore_failed'])
const cliVersion = value => typeof value === 'string' && value.length <= 32 && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)

function registrationDiagnostic(report, kind, proof) {
  const harness = kind === 'claude' ? 'claude_code' : 'codex', row = report.templates?.[kind]
  if (!/^[a-f0-9]{40}$/.test(report.sourceCommit ?? '') || !/^[a-f0-9]{40}$/.test(report.workerSha ?? '')
    || row?.baseTemplate !== kind || row.preinstalled !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(row.templateId ?? '')
    || proof?.harness !== harness || !UUID.test(proof.deviceId ?? '') || !/^[a-f0-9]{64}$/.test(proof.binarySha256 ?? '')
    || !cliVersion(proof.version) || typeof proof.binary !== 'string' || proof.binary.length > 1024
    || !/^\/(?:usr|opt|home|root|bin|sbin)\/[A-Za-z0-9@._+/-]+$/.test(proof.binary)
    || resolve(proof.binary) !== proof.binary || /^\/opt\/mikka(?:\/|$)/.test(proof.binary)) return undefined
  return { sourceCommit: report.sourceCommit, workerSha: report.workerSha, templateId: row.templateId,
    harness, deviceId: proof.deviceId, binary: proof.binary, binarySha256: proof.binarySha256, version: proof.version }
}

function cleanupFailure(row) {
  const step = CLEANUP_STEPS.get(row?.step)
    ?? (typeof row?.step === 'string' && row.step.startsWith('runStopped_') && UUID.test(row.step.slice(11)) ? 'run_stop' : 'unknown')
  const http = typeof row?.code === 'string' && /^startup_http_([45][0-9]{2})$/.exec(row.code)
  return { step, code: STARTUP_CODES.has(row?.code) || CLEANUP_CODES.has(row?.code) ? row.code : http ? 'http_error' : 'failed',
    ...(http ? { httpStatus: Number(http[1]) } : {}) }
}

function candidateDiagnostic(kind, stage, error, acceptance, cleanupErrors, deviceId, { sourceCommit, cleanupDetails, passedReceipt, registeredProof }) {
  const sample = acceptance?.samples?.[0]
  const harness = kind === 'claude' ? 'claude_code' : 'codex'
  const runIdHash = UUID.test(sample?.runId ?? '') ? createHash('sha256').update(sample.runId).digest('hex').slice(0, 16) : null
  const timing = runIdHash ? readRuntimeTiming(sample?.runtimeTiming, { runIdHash, harness }) : null
  const evidence = runtimeEvidence(timing, { requireOfficial: true })
  const agentStart = Array.isArray(sample?.stages) ? sample.stages.slice(0, 3).find(row => row?.stage === 'agent_start') : null
  const startup = sample?.daemonStartupTiming
  const cliInit = runIdHash !== null && startup?.version === 1 && startup.runIdHash === runIdHash && startup.harness === harness
    && startup.truncated === false && Array.isArray(startup.phases) && startup.phases.length <= 64
    ? startup.phases.find(row => row?.name === 'daemon.adapter.cli_init') : null
  const observation = error && sample ? {
    lastStatus: RUN_STATUSES.has(sample.lastStatus) ? sample.lastStatus : 'unavailable',
    agentStart: Boolean(sample.agentStart), providerChunk: Boolean(sample.firstProviderChunk),
    agentStartStage: typeof agentStart?.ok === 'boolean' && duration(agentStart.ms) ? { ok: agentStart.ok, ms: agentStart.ms } : null,
    cliInit: ['ok', 'error'].includes(cliInit?.outcome) && duration(cliInit.ms) ? { outcome: cliInit.outcome, ms: cliInit.ms } : null,
    replyVerified: sample.replyVerified === true, replyVerifiedAfterTool: sample.replyVerifiedAfterTool === true,
    successfulTool: Array.isArray(sample.toolCalls) && sample.toolCalls.slice(0, 64).some(row => row?.outcome === 'ok' && /^[a-f0-9]{16}$/.test(row.toolCallHash ?? '')),
    runtimeTimingStatus: TIMING_STATUSES.has(sample.runtimeTimingStatus) ? sample.runtimeTimingStatus : 'unavailable',
    expectedAgentAck: timing?.agentAccepted?.kind === (harness === 'codex' ? 'codex_turn_start_ack' : 'claude_user_ack'),
    runtimeEvidence: { status: evidence.status, reason: evidence.reason ?? null },
  } : undefined
  const fixture = error && sample?.sourceCommit === sourceCommit && sample.harness === harness
    && sample.placement?.kind === 'device' && sample.placement.deviceId === deviceId
    && UUID.test(sample.issueId ?? '') && UUID.test(sample.runId ?? '')
    ? { issueId: sample.issueId, runId: sample.runId } : undefined
  const cleanupFailures = [sample?.cleanup?.errors, acceptance?.cleanup?.errors, cleanupDetails]
    .flatMap(rows => Array.isArray(rows) ? rows.slice(0, 9) : []).map(cleanupFailure)
  const cleanup = new Set(cleanupErrors)
  if (acceptance?.cleanup?.errors?.length || sample?.cleanup?.errors?.length || sample?.cleanup?.status === 'failed') cleanup.add('acceptance_cleanup_failed')
  if (sample?.cleanup?.errors?.some(row => row?.code === 'startup_cleanup_terminal_timeout')) cleanup.add('terminal_timeout')
  const retained = sample?.cleanup?.retainedFixture
  const retainedRunIds = Array.isArray(retained?.runIds) ? [...new Set(retained.runIds.map(id => typeof id === 'string' ? id.toLowerCase() : id))] : []
  const retainedFixture = UUID.test(retained?.issueId ?? '') && retained.issueId === sample.issueId
    && retainedRunIds.length > 0 && retainedRunIds.length <= 4 && retainedRunIds.every(id => typeof id === 'string' && UUID.test(id))
    ? { issueId: retained.issueId, runIds: retainedRunIds } : undefined
  return { kind, stage, code: error ? safeCode(error) : 'passed',
    runIdHash,
    sampleStatus: SAMPLE_STATUSES.has(sample?.status) ? sample.status : 'unavailable',
    sampleError: sample?.error ? STARTUP_CODES.has(sample.error) ? sample.error : 'startup_failed' : null,
    cleanupErrors: [...cleanup], ...(observation ? { observation } : {}), ...(fixture ? { fixture } : {}),
    ...(cleanupFailures.length ? { cleanupFailures: cleanupFailures.slice(0, 8), cleanupFailuresTruncated: cleanupFailures.length > 8 } : {}),
    // Only the existing strict candidateReceipt can populate this proof. A
    // failed pair still produces no accepted.json and can never publish it.
    ...(passedReceipt && cliVersion(passedReceipt.officialCliVersion) && /^[a-f0-9]{64}$/.test(passedReceipt.officialBinarySha256 ?? '') ? { passedReceipt } : {}),
    // Registration proves the selected original binary, not task execution.
    ...(error && registeredProof ? { candidateProof: registeredProof } : {}),
    ...(retainedFixture ? { retainedFixture } : {}),
    ...(cleanup.has('device_remove_failed') && UUID.test(deviceId ?? '') ? { registeredDeviceId: deviceId } : {}) }
}

export function candidateReceipt(report, kind, proof, acceptance, expectedScope) {
  const [, harness, model] = KINDS.find(row => row[0] === kind)
  const sample = acceptance.samples?.[0]
  check(acceptance.mode === 'candidate' && acceptance.status === 'candidate_subscription_proved' && acceptance.samples?.length === 1 && !acceptance.error
    && !acceptance.cleanup?.errors?.length && sample?.status === 'execution_proved_awaiting_server_timing'
    && sample.cleanup?.status === 'passed' && acceptance.officialTiming?.enabled === true && acceptance.officialTiming.cleaned === true, 'execution_failed')
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
  const authorization = runtimeEvidence(runtime, { requireOfficial: true })
  check(sample.requireAgentAcceptance === true && sample.requireRuntimeReceipt === true && sample.requireOfficialTiming === true
    && runtime?.complete === true && runtime.truncated === false
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
    runtimeAuthorization: { source: runtime.source, scope: runtime.scope, complete: true, truncated: false,
      hostAuthorizationComplete: authorization.hostAuthorizationComplete, basis: authorization.basis,
      allFirstPartyHttpComplete: false, extraRemoteCalls: authorization.extraRemoteCalls,
      mcpHttpTiming: runtime.mcpHttpTiming, observedProviderEvents: authorization.observedProviderEvents,
      officialDelivery: authorization.officialDelivery } }
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
      let sandbox, deviceId, acceptance, diagnosticError, registeredProof, enrollmentIssued = false, stage = 'candidate'
      const cleanupErrors = [], cleanupDetails = []
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
          registeredProof = registrationDiagnostic(report, kind, proof)
          stage = 'agents'
          const agents = await client.rpc('agents.listAgents', [])
          const matching = agents.filter(agent => agent.deviceId === deviceId && agent.harness === harness)
          check(matching.length === 1, 'registered_agent_missing')
          stage = 'acceptance'
          acceptance = await runAcceptance({ origin, workspace: scope.workspaceId,
            botId: bot.botId, mode: 'candidate', strategy: 'derived', runs: 1, harness,
            deviceId, agentId: matching[0].id, revision: report.sourceCommit, expectedBuild: version.build,
            timeoutMs: 240000, maxStartupMs: 5000, minToolCalls: 1,
            runtimeEvidence: 'required', officialTiming: 'enabled' }, { env, fetchImpl })
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
            if (UUID.test(proof.deviceId ?? '') && proof.harness === harness) {
              deviceId = proof.deviceId
              registeredProof = registrationDiagnostic(report, kind, proof)
            }
          } catch { /* No successful registration may have been recorded. */ }
        }
        if (deviceId) {
          try { await client.rpc('agents.removeDevice', [deviceId]) }
          catch (error) {
            const failure = Error('template_gate_device_cleanup_failed', { cause: error })
            failures.push({ kind, error: failure }); cleanupErrors.push('device_remove_failed')
            cleanupDetails.push({ step: 'device_remove', code: error?.message })
            if (!diagnosticError) { diagnosticError = failure; stage = 'cleanup' }
          }
        }
        if (sandbox) {
          try { await sandbox.kill() }
          catch (error) {
            const failure = Error('template_gate_sandbox_cleanup_failed', { cause: error })
            failures.push({ kind, error: failure }); cleanupErrors.push('sandbox_kill_failed')
            cleanupDetails.push({ step: 'sandbox_kill', code: error?.message })
            if (!diagnosticError) { diagnosticError = failure; stage = 'cleanup' }
          }
        }
        onDiagnostic(candidateDiagnostic(kind, stage, diagnosticError, acceptance, cleanupErrors, deviceId,
          { sourceCommit: report.sourceCommit, cleanupDetails, passedReceipt: passed[kind], registeredProof }))
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
