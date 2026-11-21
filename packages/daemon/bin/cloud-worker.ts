// Invoked only by trusted E2B infrastructure, as the template's default user
// (decision 2026-11-01-2335). The handoff path and data directory are fixed;
// no credential enters argv.
import { existsSync } from 'node:fs'
import { consumeCloudBootstrap, installCloudCredential, preloadCloudWorker } from '../src/cloud-bootstrap'
import type { HostedModelProbe } from '../src/cloud-model-probe'
import { runCli } from '../src/cli'
import { daemonTracer } from '../src/tracing'
import { DAEMON_VERSION } from '../src/paths'
import { hostedBinaries } from '../src/hosted-binaries'
import { startAnonymousCodex } from '../src/anonymous-codex-spare'
import { startAnonymousClaude } from '../src/anonymous-claude-spare'

const cloudflareTask = process.argv.includes('--cloudflare-task')
const root = cloudflareTask ? '/home/node/.mikka' : '/home/user/.mikka'
let anonymousAttempted = false
async function accept(preloadedModels?: HostedModelProbe) {
  const config = consumeCloudBootstrap(`${root}/bootstrap.json`)
  daemonTracer.configure(config.tracing, { version: DAEMON_VERSION })
  return daemonTracer.withContext(config.traceContext, async () => {
    const dataDir = `${root}/worker`
    if (await daemonTracer.span('daemon.bootstrap.credential', {}, () => installCloudCredential(dataDir, config)) === 'updated') return
    let anonymousCodexCandidate: ReturnType<typeof startAnonymousCodex>
    let anonymousClaudeCandidate: ReturnType<typeof startAnonymousClaude>
    if (!anonymousAttempted && config.anonymousClaudeHint) {
      anonymousAttempted = true
      const binary = hostedBinaries().claude_code
      if (binary) anonymousClaudeCandidate = startAnonymousClaude({ hint: config.anonymousClaudeHint,
        bootstrap: { sha256: config.anonymousClaudeHint.bootstrapSha256, deviceId: config.deviceId, workspaceId: config.workspaceId },
        stateDir: `${dataDir}/adapters`, binary, env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        signal: new AbortController().signal })
    }
    if (!anonymousAttempted && config.anonymousCodexHint) {
      anonymousAttempted = true
      const binary = hostedBinaries().codex
      if (binary) anonymousCodexCandidate = startAnonymousCodex({ hint: config.anonymousCodexHint,
        bootstrap: { sha256: config.anonymousCodexHint.bootstrapSha256, deviceId: config.deviceId, workspaceId: config.workspaceId },
        stateDir: dataDir + '/adapters', binary,
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        signal: new AbortController().signal })
    }
    // Only the desktop template carries a desktop and its driver; a task machine
    // (E2B's claude or codex template) has neither.
    const computer = !cloudflareTask && existsSync('/opt/mikka/computer/cua-driver') ? ['--e2b-computer'] : []
    // Diagnostics are opt-in per assignment. A trusted operator can authorize a
    // bounded Bot/repository window through the existing claim response.
    const host = cloudflareTask ? [] : ['--e2b-container-runtime']
    let announced = false
    const taskRegistered = () => {
      if (!announced) {
        announced = true
        process.stdout.write('mikka-task-worker-registered\n')
      }
    }
    let code: number | null
    try { code = await runCli(['daemon', '--data-dir', dataDir, '--server', config.server, '--hosted-subscriptions', ...host, ...computer], undefined, { ...(cloudflareTask ? { taskRegistered } : {}), protectionBypass: config.protectionBypass, preloadedModels, initialRunId: config.initialRunId, collectCliTiming: config.collectCliTiming, anonymousClaudeCandidate, anonymousCodexCandidate }) }
    catch (error) { await Promise.all([anonymousClaudeCandidate?.close(), anonymousCodexCandidate?.close()]); throw error }
    if (code !== null && code !== 0) { await Promise.all([anonymousClaudeCandidate?.close(), anonymousCodexCandidate?.close()]); throw new Error('Cloud worker failed') }
  })
}
const failed = () => { process.stderr.write('Cloud worker unavailable\n'); process.exit(1) }
if (cloudflareTask) {
  void import('../src/cloudflare-task-handoff').then(async ({ receiveTaskHandoff }) => {
    await receiveTaskHandoff(root, process.stdin)
    return accept()
  }).catch(failed)
} else if (process.argv.includes('--probe-models')) {
  void import('../src/cloud-model-probe').then(async ({ probeHostedModels }) => {
    process.stdout.write(JSON.stringify(await probeHostedModels()) + '\n')
  }).catch(failed)
} else if (process.argv.includes('--wait-bootstrap')) {
  // The template snapshot contains imported software and an idle watcher,
  // never a device identity, provider key or viewer signing key.
  void preloadCloudWorker(root, accept, failed).catch(failed)
} else {
  void accept().catch(failed)
}
