#!/usr/bin/env node
/** Issue #1918: explicitly authorized owned Codex/Luna Cloud Task MCP case.
 * Preparation is offline. --execute creates one normal task, with no retries. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import * as api from './cloud-startup.mjs'
import { nativeProbeCommand, nativeReceipt } from './coding-workspace.mjs'
import { readRunFailure } from '../../packages/protocol/src/run-failure.ts'
import { OWNED_CODEX_ACTOR, ownedCodexAccount, selectOwnedCodexWorkspace } from './owned-codex-actor.mjs'

const ORIGIN = 'https://app.aspectlylabs.com', ENDPOINT = 'https://mcp.deepwiki.com/mcp'
const REPOSITORY = 'vercel/ai', DOCUMENT = 'https://deepwiki.com/vercel/ai'
const MODELS = { codex: 'gpt-6-luna' }
const SHA = /^[a-f0-9]{40}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const TERMINAL = new Set(['succeeded', 'completed'])
const CODES = new Set(['options_invalid', 'proxy_required', 'account_mismatch', 'acceptance_aborted',
  'build_mismatch', 'worker_mismatch', 'paid_fallback_enabled', 'connection_invalid', 'connection_changed', 'connection_cleanup_failed', 'profile_missing',
  'run_scope_mismatch', 'tool_receipt_invalid', 'handoff_invalid', 'native_tool_invalid', 'native_worker_mismatch', 'native_mcp_unproved', 'cleanup_failed', 'failed'])
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (value, code) => { if (!value) throw Object.assign(new Error(`native_mcp_${code}`), { code }) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const closedError = error => CODES.has(error?.code) ? error.code
  : api.STARTUP_FAILURE_CODES.includes(error?.message) ? error.message : 'failed'
const now = () => new Date().toISOString()

export function options(args) {
  const value = { harness: 'codex', execute: false }
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--execute') { value.execute = true; continue }
    const next = args[++index]
    check(next && !next.startsWith('--'), 'options_invalid')
    const names = { '--expected-build': 'build', '--expected-worker-sha': 'workerSha',
      '--expected-worker-source': 'workerSourceCommit', '--output': 'output', '--harness': 'harness' }
    check(names[key] && (value[names[key]] === undefined || key === '--harness'), 'options_invalid')
    value[names[key]] = next
  }
  check(value.output && SHA.test(value.build ?? '') && SHA.test(value.workerSha ?? '')
    && SHA.test(value.workerSourceCommit ?? '') && value.harness === 'codex', 'options_invalid')
  value.output = resolve(value.output); value.journal = value.output + '.fixture.jsonl'
  value.harnesses = ['codex']; value.actor = OWNED_CODEX_ACTOR
  return value
}

function textOutput(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n')
  if (value?.isError === true || value?.error) return ''
  return Array.isArray(value?.content) ? textOutput(value.content) : ''
}

/** Actual task stream only: exact native server, input and finished output. */
export function remoteReceipt(detail, record, serverId) {
  const thread = detail?.thread
  check(thread?.id === record.runId && thread.rootRunId === record.runId && thread.latestRunId === record.runId
    && thread.ownedByCurrentUser === true && !thread.continuation && thread.attempts?.length === 1
    && thread.attempts[0].runId === record.runId && thread.detail?.harness === record.harness, 'run_scope_mismatch')
  const prefix = `mcp__mcp_${serverId.replaceAll('-', '')}__`, inputs = new Map(), calls = new Map(), handoffs = new Map()
  let started = false
  for (const [index, item] of (detail.chunks ?? []).entries()) {
    const chunk = item.chunk
    if (chunk?.type === 'data-run-stage' && chunk.data?.stage === 'agent_start' && chunk.data.ok === true) started = true
    if (!started) continue
    if (chunk?.type === 'tool-input-available') {
      const tool = chunk.toolName === prefix + 'read_wiki_structure' ? 'read_wiki_structure' : null
      if (tool) {
        check(typeof chunk.toolCallId === 'string' && chunk.toolCallId.length > 0 && chunk.toolCallId.length <= 512
          && chunk.input?.repoName === REPOSITORY && Object.keys(chunk.input).length === 1, 'tool_receipt_invalid')
        inputs.set(chunk.toolCallId, { tool, index })
      }
      if (chunk.toolName === 'mcp__mikka__submit') {
        const summary = chunk.input?.summary
        if (typeof summary === 'string' && summary.includes(`STARTUP_OK_${record.sampleId}`)) {
          check(summary.length >= 300 && summary.length <= 8000 && summary.includes(DOCUMENT)
            && /eve/i.test(summary) && /AI[ -]SDK/i.test(summary) && /stream|流/i.test(summary)
            && /tool|工具/i.test(summary) && /MCP/i.test(summary), 'handoff_invalid')
          handoffs.set(chunk.toolCallId, { summarySha256: hash(summary), bytes: Buffer.byteLength(summary), index })
        }
      }
    }
    if (chunk?.type === 'tool-output-error') { calls.delete(chunk.toolCallId); handoffs.delete(chunk.toolCallId) }
    if (chunk?.type === 'tool-output-available') {
      const input = inputs.get(chunk.toolCallId)
      if (input) {
        const text = textOutput(chunk.output)
        check(text.length >= 80 && text.length <= 2_000_000
          && chunk.output?.isError !== true && !chunk.output?.error && index > input.index, 'tool_receipt_invalid')
        calls.set(chunk.toolCallId, { tool: input.tool, toolCallHash: hash(chunk.toolCallId), outputSha256: hash(text),
          outputBytes: Buffer.byteLength(text), inputIndex: input.index, outputIndex: index })
      }
      const handoff = handoffs.get(chunk.toolCallId)
      if (handoff) {
        check(chunk.output?.isError !== true && !chunk.output?.error && chunk.output?.ok !== false, 'handoff_invalid')
        handoff.outputIndex = index
      }
    }
  }
  const receipts = [...calls.values()]
  check(inputs.size <= 1 && receipts.length <= 1, 'tool_receipt_invalid')
  if (!receipts.some(row => row.tool === 'read_wiki_structure')) return null
  const handoff = [...handoffs.values()].find(row => row.outputIndex > row.index && receipts.every(call => call.outputIndex < row.index))
  if (!handoff || !TERMINAL.has(thread.status)) return null
  return { serverId, serverName: prefix.slice(5, -2), repository: REPOSITORY, docs: DOCUMENT, calls: receipts,
    handoff: { summarySha256: handoff.summarySha256, bytes: handoff.bytes, successful: true }, terminal: thread.status }
}

export async function independentCases(harnesses, runOne) {
  const results = []
  for (const harness of harnesses) {
    try { results.push({ harness, result: await runOne(harness) }) }
    catch (error) { results.push({ harness, failure: closedError(error) }) }
  }
  return results
}

export async function run(config, env = process.env, { fetchImpl = fetch, readWorkerRelease, startup = api.runCloudStartup,
  clock = now, journal = async row => appendFile(config.journal, JSON.stringify(row) + '\n', { mode: 0o600 }) } = {}) {
  check(config.actor === OWNED_CODEX_ACTOR && config.harnesses?.length === 1 && config.harnesses[0] === 'codex', 'options_invalid')
  const credentials = ownedCodexAccount(env)
  const report = { issue: 1918, actor: OWNED_CODEX_ACTOR, caseId: randomUUID(), purpose: 'owned_codex_cloud_task_native_http_mcp', origin: ORIGIN, build: config.build,
    workerSha: config.workerSha, workerSourceCommit: config.workerSourceCommit, harnesses: config.harnesses,
    startedAt: clock(), status: 'failed', samples: [], cleanup: { errors: [] } }
  check(!env.HTTPS_PROXY || env.NODE_USE_ENV_PROXY === '1', 'proxy_required')
  const client = api.createSessionClient(ORIGIN, fetchImpl)
  const controller = new AbortController(), abort = () => controller.abort()
  process.once('SIGTERM', abort); process.once('SIGINT', abort)
  let loggedIn = false, originalWorkspace, scope, ownerId, server, ownsServer = false
  const fixtureName = `测试 1918 owned Codex MCP ${report.caseId}`
  const baselineIds = new Set()
  const pin = async () => {
    check(!controller.signal.aborted, 'acceptance_aborted')
    const version = await client.json('/api/version')
    check(version.build === config.build, 'build_mismatch')
    const worker = await (readWorkerRelease ?? (() => api.readProductionWorkerRelease({ token: env.VERCEL_TEAM_TOKEN, fetchImpl })))()
    check(worker.workerSha === config.workerSha && worker.sourceCommit === config.workerSourceCommit, 'worker_mismatch')
  }
  const markCleanup = async (step, work) => {
    try { await work(); report.cleanup[step] = true }
    catch (error) { report.cleanup.errors.push({ step, code: closedError(error) }) }
  }
  try {
    await journal({ version: 1, kind: 'case', caseId: report.caseId, actor: report.actor, build: config.build, workerSha: config.workerSha, workerSourceCommit: config.workerSourceCommit })
    await pin()
    const login = await client.request('/api/auth/sign-in/email', post({ ...credentials, rememberMe: false }))
    loggedIn = login.ok; await login.body?.cancel()
    check(loggedIn, 'account_mismatch')
    const identity = await client.json('/api/auth/get-session'); ownerId = identity.user?.id
    check(identity.user?.email?.toLowerCase() === credentials.email.toLowerCase() && ownerId, 'account_mismatch')
    report.accountHash = hash(ownerId).slice(0, 16)
    scope = await selectOwnedCodexWorkspace(client, { ownerId }, value => { originalWorkspace = value })
    report.workspace = scope.evidence
    const verifyPolicy = async () => {
      const keys = await client.json('/api/settings/api-keys?workspace=' + scope.workspaceId)
      check(keys.apiKeyAfterQuota === false, 'paid_fallback_enabled')
    }
    await verifyPolicy()
    const baseline = await client.json('/api/integrations/mcp')
    check(Array.isArray(baseline.servers), 'connection_invalid')
    for (const row of baseline.servers) baselineIds.add(row.id)
    const created = await client.json('/api/integrations/mcp', post({ name: fixtureName,
      url: ENDPOINT, transport: 'http', enabled: true }))
    server = created.server
    check(UUID.test(server?.id ?? '') && !baselineIds.has(server.id) && server.name === fixtureName && server.url === ENDPOINT && server.transport === 'http' && server.enabled
      && server.authKind === 'none' && Number.isSafeInteger(server.revision) && server.revision > 0, 'connection_invalid')
    ownsServer = true
    await journal({ kind: 'mcp_connection', id: server.id, caseId: report.caseId, actor: report.actor })
    report.connection = { id: server.id, revision: server.revision, transport: 'http', authentication: 'none', shared: false }
    const verifyConnection = async () => {
      const page = await client.json(`/api/integrations/mcp?workspaceId=${scope.workspaceId}`)
      const current = page.servers?.find(row => row.id === server.id)
      check(current?.name === fixtureName && current?.mine === true && !current.shared && current.url === ENDPOINT && current.enabled
        && current.transport === 'http' && current.authKind === 'none' && current.revision === server.revision, 'connection_changed')
    }
    await verifyConnection()
    const cases = await independentCases(config.harnesses, async harness => {
      await pin(); await verifyConnection(); await verifyPolicy()
      return startup({ origin: ORIGIN, actor: OWNED_CODEX_ACTOR, runs: 1, harness,
      mode: 'baseline', strategy: 'derived', revision: config.build, expectedBuild: config.build,
      expectedWorkerSha: config.workerSha, expectedWorkerSource: config.workerSourceCommit,
      timeoutMs: 360000, maxStartupMs: 60000, runtimeEvidence: 'optional', officialTiming: 'disabled', titlePrefix: '测试 1918 native MCP' }, {
      env, fetchImpl, onFixture: async fixture => journal({ ...fixture, caseId: report.caseId, actor: report.actor }), caseProfileInstructions: 'Produce a sourced Eve/AI SDK documentation map and integration recommendations using one read_wiki_structure call on the explicitly configured public DeepWiki MCP server and the exact read-only worker proof requested by the task. Distinguish returned topic facts from recommendations. Do not read the entire wiki. Never inspect credentials or environment, install software, write files, commit, push, open PRs, message others or spawn agents.',
      createCaseProbe: async ({ client: taskClient, record }) => {
        await pin(); await verifyConnection(); await verifyPolicy()
        record.requireTerminal = true
        const serverName = `mcp_${server.id.replaceAll('-', '')}`
        record.nativeMcp = { status: 'awaiting_actual_cli_receipts', serverId: server.id, revision: server.revision }
        return {
          signal: controller.signal,
          instructions: `Create a useful 150-300 word documentation map and integration recommendations for Mikka's Eve migration. In the task CLI, call the configured ${serverName} MCP server's read_wiki_structure tool exactly once with only {"repoName":"vercel/ai"}. Use the returned topic names to map which AI SDK documentation should guide model generation, tool execution and streaming. Clearly label returned topic facts separately from your recommendations about Eve durable session ownership and native task MCP configuration. Do not claim you read topic contents. Cite ${DOCUMENT}. Do not call read_wiki_contents, ask_question, web fetch, shell curl, another MCP server, or merely list available tools. Before handing off, run this exact read-only native shell proof once (it reads the README and root-owned worker release markers only; never inspect environment or credentials):\n${nativeProbeCommand(record.sampleId, record.harness)}\nThen use mcp__mikka__submit to deliver the note in its summary, including STARTUP_OK_${record.sampleId}. No files, branches, commits, PRs, external messages or agents.`,
          createIssue: input => taskClient.rpc('issues.saveIssue', [{ ...input, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read the AI SDK wiki topic structure through the selected DeepWiki MCP server once and deliver a sourced documentation map plus Eve integration recommendations. Read only; no repository changes or external messages.' }] }] } }]),
          observe: async detail => {
            const rawFailure = detail.thread?.failureDetails
            const failure = readRunFailure(rawFailure) ?? (rawFailure && typeof rawFailure === 'object'
              ? readRunFailure({ ...rawFailure, causes: [] }) : null)
            if (failure) record.providerFailure = { code: failure.code, category: failure.category, provider: failure.provider,
              status: failure.status, causes: failure.causes.map(({ name, code, detail }) => ({ name, code, detail })) }
            const remote = remoteReceipt(detail, record, server.id), worker = nativeReceipt(detail, record, config)
            if (!remote || !worker) return false
            record.nativeMcp = { status: 'passed', serverId: server.id, revision: server.revision, remote,
              worker: { workerSha: worker.workerSha, workerSourceCommit: worker.workerSourceCommit, runId: worker.runId,
                toolCallHash: worker.toolCallHash, commandSha256: worker.commandSha256 } }
            return true
          },
          afterRelease: async () => {
            check(record.cleanup?.status === 'passed' && (!record.runId || record.cleanup.machines?.length > 0
              && record.cleanup.machines.every(machine => machine.state === 'ended' && machine.outcome === 'ended')), 'cleanup_failed')
            if (record.issueId) {
              const { issue } = await taskClient.rpc('issues.getIssue', [record.issueId])
              check(issue?.id === record.issueId && issue.title === record.title, 'run_scope_mismatch')
              await taskClient.rpc('issue-operations.setIssueDeleted', [{ id: issue.id, revision: issue.revision }])
              record.cleanup.taskDeleted = true
            }
            delete record.cleanup.taskRetained; delete record.cleanup.retainedFixture
            await pin(); await verifyConnection()
          },
        }
      },
      })
    })
    report.samples = cases.map(({ harness, result: startup, failure }) => {
      const sample = startup?.samples?.[0]
      const owned = sample?.execution?.ownedScope, proof = sample?.nativeMcp
      const passed = startup?.actor === OWNED_CODEX_ACTOR && owned?.verified === true && owned.access === 'owner'
        && owned.requesterHash === report.accountHash && owned.payerHash === report.accountHash && sample.execution.sharedScope === undefined
        && owned.workspaceHash === scope.evidence.workspaceHash && startup.workspace?.kind === 'personal'
        && startup.workspace.workspaceHash === scope.evidence.workspaceHash
        && startup?.samples?.length === 1 && sample.harness === harness && sample.status !== 'failed' && UUID.test(sample.issueId ?? '')
        && sample.execution.model === MODELS[harness] && sample.execution.credentialType === 'subscription'
        && proof?.status === 'passed' && proof.serverId === server.id && proof.revision === server.revision
        && proof.worker?.runId === sample.runId && proof.worker.workerSha === config.workerSha && proof.worker.workerSourceCommit === config.workerSourceCommit
        && proof.remote?.serverId === server.id && proof.remote.calls?.length === 1 && proof.remote.handoff?.successful === true
        && TERMINAL.has(proof.remote.terminal) && sample.cleanup?.status === 'passed' && sample.cleanup.taskDeleted === true
        && startup.build === config.build && startup.revision === config.build && !startup.error
        && !startup.cleanup?.errors?.length && startup.cleanup.workspaceRestored === true
      return { harness, model: MODELS[harness], sampleId: sample?.sampleId, issueId: sample?.issueId, runId: sample?.runId,
        status: passed ? 'passed' : 'failed', failure: failure ?? sample?.failure?.code ?? sample?.error ?? startup?.error ?? (passed ? null : 'native_mcp_unproved'),
        providerFailure: sample?.providerFailure, execution: sample?.execution, proof: sample?.nativeMcp,
        cleanup: sample?.cleanup, applicationCleanup: startup?.cleanup }
    })
    await pin()
    report.status = report.samples.every(sample => sample.status === 'passed') ? 'passed'
      : report.samples.some(sample => sample.status === 'passed') ? 'partial' : 'failed'
  } catch (error) { report.failure = closedError(error) }
  finally {
    if (ownsServer && server?.id && UUID.test(server.id)) await markCleanup('connectionDeleted', async () => {
      await client.json('/api/integrations/mcp', { ...post({ id: server.id }), method: 'DELETE' })
      const current = await client.json('/api/integrations/mcp')
      check(Array.isArray(current.servers) && !current.servers.some(row => row.id === server.id), 'connection_cleanup_failed')
    })
    if (loggedIn && originalWorkspace) await markCleanup('workspaceRestored', () => api.restoreAcceptanceWorkspace(client, ownerId, originalWorkspace))
    if (loggedIn) await markCleanup('sessionClosed', async () => {
      const result = await client.request('/api/auth/sign-out', post({})); const ok = result.ok; await result.body?.cancel(); check(ok, 'cleanup_failed')
    })
    client.clear()
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort)
  }
  report.finishedAt = clock()
  if (report.cleanup.errors.length) report.status = 'failed'
  await journal({ kind: 'result', caseId: report.caseId, actor: report.actor, status: report.status, runIds: report.samples.map(row => row.runId).filter(Boolean), cleanup: report.cleanup })
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let output
  try {
    const config = options(process.argv.slice(2)); output = config.output
    if (!config.execute) console.log(JSON.stringify({ status: 'prepared_no_network', actor: OWNED_CODEX_ACTOR, harnesses: config.harnesses,
      build: config.build, workerSha: config.workerSha, workerSourceCommit: config.workerSourceCommit,
      requiredEnvironment: ['MIKKA_TEST_ACCOUNT_EMAIL', 'MIKKA_TEST_ACCOUNT_PASSWORD', 'VERCEL_TEAM_TOKEN', 'NODE_USE_ENV_PROXY=1'], executionRequires: '--execute after root READY signal' }))
    else {
      await mkdir(dirname(output), { recursive: true })
      const reportFile = await open(output, 'wx', 0o600)
      try {
        await writeFile(config.journal, '', { mode: 0o600, flag: 'wx' })
        const driverRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }).trim()
        const report = await run(config)
        report.driverRevision = driverRevision
        await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n')
        console.log(JSON.stringify({ status: report.status, report: output, samples: report.samples.map(({ harness, status, runId, failure }) => ({ harness, status, runId, failure })) }))
        if (report.status !== 'passed') process.exitCode = 1
      } finally { await reportFile.close() }
    }
  } catch (error) { console.error(JSON.stringify({ status: 'failed_before_report', code: closedError(error), ...(output ? { output } : {}) })); process.exitCode = 1 }
}
