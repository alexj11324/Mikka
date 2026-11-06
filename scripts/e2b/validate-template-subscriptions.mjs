#!/usr/bin/env node
/** Candidate-image release gate. All credentials stay in memory or the
 * disposable instance's private stdin file, never in the template/report. */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runCloudStartup, createSessionClient } from '../acceptance/cloud-startup.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const KINDS = [['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']]
const fail = (code, cause) => { throw Error(`template_gate_${code}`, cause ? { cause } : undefined) }
const check = (value, code) => { if (!value) fail(code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export function candidateReceipt(report, kind, proof, acceptance) {
  const [, harness, model] = KINDS.find(row => row[0] === kind)
  const sample = acceptance.samples?.[0]
  check(acceptance.mode === 'candidate' && acceptance.status === 'candidate_subscription_proved' && acceptance.samples?.length === 1 && !acceptance.error
    && !acceptance.cleanup?.errors?.length && sample?.status === 'execution_proved_awaiting_server_timing'
    && sample.cleanup?.status === 'passed', 'execution_failed')
  check(sample.harness === harness && sample.execution?.harness === harness && sample.execution?.model === model
    && sample.execution?.deviceId === proof.deviceId && sample.execution?.credentialType === 'subscription'
    && sample.credentialRoute === 'subscription' && sample.replyVerified === true
    && sample.sourceCommit === report.sourceCommit && UUID.test(sample.runId ?? ''), 'execution_evidence_invalid')
  return { status: 'passed', templateId: report.templates[kind].templateId, sourceCommit: report.sourceCommit,
    workerSha: report.workerSha, harness, model, credentialRoute: 'subscription', replyVerified: true,
    runId: sample.runId, deviceId: proof.deviceId, officialBinarySha256: proof.binarySha256,
    officialCliVersion: proof.version }
}

export async function validateTemplateSubscriptions(report, { env = process.env, fetchImpl = fetch,
  sandboxFactory, runAcceptance = runCloudStartup } = {}) {
  check(/^[a-f0-9]{40}$/.test(report.sourceCommit ?? '') && /^[a-f0-9]{40}$/.test(report.workerSha ?? ''), 'source_invalid')
  check(!env.GITHUB_SHA || env.GITHUB_SHA === report.sourceCommit, 'source_mismatch')
  check(env.ACME_DEMO_EMAIL?.toLowerCase() === 'alex@acme.aspectlylabs.com' && env.ACME_DEMO_PASSWORD, 'account_required')
  check(UUID.test(env.MIKKA_ACCEPTANCE_WORKSPACE_ID ?? '') && UUID.test(env.MIKKA_ACCEPTANCE_BOT_ID ?? ''), 'fixtures_required')
  const origin = 'https://app.aspectlylabs.com', client = createSessionClient(origin, fetchImpl)
  if (!sandboxFactory) {
    const { Sandbox } = await import('e2b')
    sandboxFactory = (template, options) => Sandbox.create(template, options)
  }
  const passed = {}, failures = []
  let loggedIn = false
  try {
    const version = await client.json('/api/version')
    check(version.build === report.sourceCommit, 'application_build_mismatch')
    const login = await client.request('/api/auth/sign-in/email', post({ email: env.ACME_DEMO_EMAIL, password: env.ACME_DEMO_PASSWORD }))
    check(login.ok, 'sign_in_failed'); loggedIn = true
    const identity = await client.json('/api/auth/get-session')
    check(identity.user?.email?.toLowerCase() === env.ACME_DEMO_EMAIL.toLowerCase(), 'account_mismatch')
    await client.rpc('workspace.switchWorkspace', [env.MIKKA_ACCEPTANCE_WORKSPACE_ID])
    for (const [kind, harness] of KINDS) {
      let sandbox, deviceId, enrollmentIssued = false
      try {
        const template = report.templates?.[kind]
        check(template?.baseTemplate === kind && template?.preinstalled === true && /^[A-Za-z0-9_-]+$/.test(template?.templateId ?? ''), 'candidate_invalid')
        sandbox = await sandboxFactory(template.templateId, { apiKey: env.E2B_API_KEY, timeoutMs: 600000,
          metadata: { application: 'mikka-template-subscription-gate', sourceCommit: report.sourceCommit, kind } })
        const installed = await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
        check(installed.trim() === report.workerSha, 'candidate_worker_mismatch')
        const grant = await client.json('/api/devices/enrollment', post({}))
        check(typeof grant.token === 'string', 'enrollment_failed')
        enrollmentIssued = true
        await sandbox.commands.run('install -d -m 700 /run/mikka-template-acceptance', { user: 'root', timeoutMs: 10000 })
        await sandbox.files.write('/run/mikka-template-acceptance/enrollment', grant.token, { user: 'root' })
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
          const agents = await client.rpc('agents.listAgents', [])
          const matching = agents.filter(agent => agent.deviceId === deviceId && agent.harness === harness)
          check(matching.length === 1, 'registered_agent_missing')
          const acceptance = await runAcceptance({ origin, workspace: env.MIKKA_ACCEPTANCE_WORKSPACE_ID,
            botId: env.MIKKA_ACCEPTANCE_BOT_ID, mode: 'candidate', strategy: 'derived', runs: 1, harness,
            deviceId, agentId: matching[0].id, revision: report.sourceCommit, expectedBuild: version.build,
            timeoutMs: 240000, maxStartupMs: 5000 }, { env, fetchImpl })
          passed[kind] = candidateReceipt(report, kind, proof, acceptance)
        } finally { clearTimeout(timer) }
      } catch (error) { failures.push({ kind, error }) }
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
          catch (error) { failures.push({ kind, error: Error('template_gate_device_cleanup_failed', { cause: error }) }) }
        }
        if (sandbox) {
          try { await sandbox.kill() }
          catch (error) { failures.push({ kind, error: Error('template_gate_sandbox_cleanup_failed', { cause: error }) }) }
        }
      }
    }
    check((await client.json('/api/version')).build === version.build, 'application_build_changed')
  } finally {
    if (loggedIn) {
      const logout = await client.request('/api/auth/sign-out', post({}))
      check(logout.ok, 'sign_out_failed')
    }
    client.clear()
  }
  if (failures.length) fail('subscription_or_cleanup_failed', new AggregateError(failures.map(row => row.error)))
  check(KINDS.every(([kind]) => passed[kind]), 'subscriptions_missing')
  return { ...report, subscriptionAcceptance: passed }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [input, output] = process.argv.slice(2)
    check(input && output, 'paths_required')
    const result = await validateTemplateSubscriptions(JSON.parse(await readFile(input, 'utf8')))
    await writeFile(output, `${JSON.stringify(result)}\n`, { mode: 0o600 })
    console.log('Both candidate images passed real official subscription execution and cleanup')
  } catch (error) {
    console.error(/^template_gate_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'template_gate_failed')
    process.exitCode = 1
  }
}
