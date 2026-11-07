#!/usr/bin/env node
/** #1593. Normal Owner/Factory tasks on the two fixed shared subscriptions.
 * No database access, polling, alternate identity, or provider mutation. The
 * optional CI E2B key can only observe a positively identified owned Task VM.
 *
 * Native submit currently auto-selects an independent next-stage Profile. No
 * public Task API pins that future selection, so this driver stops at a real
 * second Owner decision after producing the review. Final Factory submission
 * remains untested. A passed question/resume scope never completes the issue;
 * a prompt or a cancellation race is not an automatic-stage admission gate.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { acceptanceBot, chooseSharedChatModel, createSessionClient, restoreAcceptanceWorkspace, selectAcceptanceTeam,
  smokeAcceptanceAccount, subscriptionProof, watchRun } from './cloud-startup.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const MODELS = Object.freeze({ claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const VM_ID = /^[a-zA-Z0-9_-]{1,100}$/
const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SNAPSHOT = 'MIKKA_1593_NATIVE '
const sha = value => createHash('sha256').update(value).digest('hex')
export const lifecycleHash = (kind, id) => sha(`${kind}:${id}`).slice(0, 12)
const iso = value => new Date(value).toISOString()
const fail = (code, cause) => { throw new Error(`lifecycle_${code}`, cause ? { cause } : undefined) }
const assert = (value, code) => { if (!value) fail(code) }
export const safeError = error => /^(?:lifecycle|startup)_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'lifecycle_failed'
const FAILURE_PHASES = new Set(['unknown', 'runtime_validation', 'source_pin', 'account_validation', 'build_pin',
  'sign_in', 'session_identity', 'workspace_selection', 'subscription_catalogue', 'owner_cloud_capability',
  'subscription_selection', 'bot_create', 'chat_model_selection', 'profile_create', 'profile_validation', 'run_case'])
const failureAt = (error, phase) => ({ phase: FAILURE_PHASES.has(phase) ? phase : 'unknown', code: safeError(error) })
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const noAbort = signal => { if (signal?.aborted) fail('interrupted') }

export function readOptions(env = process.env) {
  assert(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_run', 'main_workflow_required')
  assert(SHA.test(env.EXPECTED_SOURCE_SHA ?? ''), 'source_pin_required')
  assert(typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP), 'runner_temp_required')
  smokeAcceptanceAccount(env)
  return { sourceCommit: env.EXPECTED_SOURCE_SHA, timeoutMs: 360000,
    reportPath: resolve(env.RUNNER_TEMP, 'thread-lifecycle-acceptance/report.json') }
}

async function pinnedSources(expected) {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 5000, maxBuffer: 200, encoding: 'utf8' })
  assert(stdout.trim() === expected, 'checkout_source_mismatch')
  const path = 'lib/cloud-computer/thread-lifecycle.ts'
  const source = await readFile(resolve(ROOT, path), 'utf8')
  const from = source.indexOf('export function threadMachineLifecycleDecision(')
  const to = source.indexOf('\nasync function requestLifecycleStop(', from)
  assert(from >= 0 && to > from && to - from < 10000, 'source_excerpt_unavailable')
  const excerpt = source.slice(from, to)
  return { path, sha256: sha(source), excerpt }
}

/** Static lookup only. A foreign-account 404 is not deletion or pause proof. */
export function createProviderObserver({ apiKey, getInfo, now = Date.now }) {
  const proven = new Map()
  return async ({ sandboxId, workspaceId, originRunId }) => {
    assert(VM_ID.test(sandboxId ?? '') && UUID.test(workspaceId ?? '') && UUID.test(originRunId ?? ''), 'provider_scope_invalid')
    const base = { requestedAt: apiKey ? iso(now()) : null, vmHash: lifecycleHash('vm', sandboxId) }
    // A response observation is timed after the awaited RPC, including missing
    // and failed responses. It is not the provider's exact transition instant.
    const observed = value => ({ ...base, observedAt: iso(now()), ...value })
    if (!apiKey) return observed({ status: 'blocked', reason: 'observation_key_unavailable', ownershipVerified: false })
    let info
    try { info = await getInfo(sandboxId, { apiKey, requestTimeoutMs: 15000 }) }
    catch (error) {
      const missing = error?.status === 404 || error?.statusCode === 404 || error?.name === 'SandboxNotFoundError'
      if (missing && proven.get(sandboxId) === `${workspaceId}:${originRunId}`)
        return observed({ status: 'observed', state: 'missing', ownershipVerified: true })
      return observed({ status: 'blocked', reason: missing ? 'account_mapping_unproven_404' : 'provider_observation_unavailable',
        ownershipVerified: proven.get(sandboxId) === `${workspaceId}:${originRunId}` })
    }
    if (info?.sandboxId !== sandboxId || info.metadata?.application !== 'mikka-thread'
      || info.metadata?.workspaceId !== workspaceId || info.metadata?.runId !== originRunId
      || !UUID.test(info.metadata?.operationId ?? '') || !['running', 'paused'].includes(info.state))
      return observed({ status: 'blocked', reason: 'provider_metadata_mismatch', ownershipVerified: false })
    proven.set(sandboxId, `${workspaceId}:${originRunId}`)
    return observed({ status: 'observed', state: info.state, ownershipVerified: true,
      operationHash: lifecycleHash('operation', info.metadata.operationId) })
  }
}

/** The exact small command is part of the task, not a provider exec channel.
 * All writes stay in the daemon-selected canonical worktree. */
export function nativeSnapshotCommand({ caseId, sourceCommit, markerValue }, phase) {
  assert(UUID.test(caseId) && SHA.test(sourceCommit) && /^[a-f0-9]{32}$/.test(markerValue), 'fixture_invalid')
  assert(['before_question', 'after_answer', 'delivery'].includes(phase), 'phase_invalid')
  const expected = JSON.stringify({ caseId, sourceCommit, markerValue }) + '\n'
  return `python3 - <<'MIKKA_1593_PY'\n` + [
    'import hashlib, json, pathlib, subprocess',
    `case_id = ${JSON.stringify(caseId)}`,
    `phase = ${JSON.stringify(phase)}`,
    `marker = pathlib.Path(${JSON.stringify(`issue-1593-${caseId}.marker`)})`,
    `report = pathlib.Path(${JSON.stringify(`issue-1593-${caseId}.md`)})`,
    `expected = ${JSON.stringify(expected)}.encode('utf-8')`,
    'root = pathlib.Path.cwd().resolve()',
    "assert subprocess.check_output(['git', 'rev-parse', '--show-toplevel']).decode().strip() == str(root)",
    "assert not marker.is_symlink() and not report.is_symlink()",
    ...(phase === 'before_question' ? ["with marker.open('xb') as stream: stream.write(expected)"] : []),
    'assert marker.read_bytes() == expected',
    "git = lambda *args: subprocess.check_output(['git', *args])",
    "tracked = hashlib.sha256()",
    "for name in git('ls-files', '-z').split(b'\\0'):",
    "    if name:",
    "        file = root / name.decode('utf-8')",
    '        assert file.is_file() and not file.is_symlink() and file.stat().st_size <= 4194304',
    "        tracked.update(name + b'\\0' + hashlib.sha256(file.read_bytes()).digest())",
    'body = report.read_bytes()',
    'assert 300 <= len(body) <= 2400',
    "value = dict(caseId=case_id, phase=phase, head=git('rev-parse', 'HEAD').decode().strip(),",
    "    rootSha256=hashlib.sha256(str(root).encode()).hexdigest(), trackedSha256=tracked.hexdigest(),",
    "    statusSha256=hashlib.sha256(git('status', '--porcelain=v1', '-z', '--untracked-files=all')).hexdigest(),",
    '    markerSha256=hashlib.sha256(expected).hexdigest(), markerBytes=len(expected),',
    '    reportSha256=hashlib.sha256(body).hexdigest(), reportBytes=len(body))',
    ...(phase === 'delivery' ? ["value['reportText'] = body.decode('utf-8')"] : []),
    `print(${JSON.stringify(SNAPSHOT)} + json.dumps(value, ensure_ascii=False, separators=(',', ':')))`,
  ].join('\n') + '\nMIKKA_1593_PY'
}

function toolText(output) {
  if (typeof output === 'string') return output
  if (output?.exitCode !== undefined) return output.exitCode === 0 && typeof output.output === 'string' ? output.output : null
  if (Array.isArray(output)) return output.filter(item => item?.type === 'text').map(item => item.text).join('\n')
  return null
}

// Codex may persist its shell wrapper instead of the supplied command. Decode
// only literal shell words: no substitutions, operators, or extra commands.
// The resulting script must equal the complete expected Python program.
export function isExactNativeCommand(command, expected) {
  if (typeof command !== 'string') return false
  if (command.trim() === expected.trim()) return true
  const words = []
  let word = '', quote = null, started = false
  for (let index = 0; index < command.length; index++) {
    const ch = command[index]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '$' || ch === '`') return false
      else if (ch === '\\') {
        const next = command[++index]
        if (next === undefined) return false
        word += ['$', '`', '"', '\\', '\n'].includes(next) ? (next === '\n' ? '' : next) : `\\${next}`
      } else word += ch
    } else if (ch === "'" || ch === '"') { quote = ch; started = true }
    else if (/\s/.test(ch)) {
      if (started) { words.push(word); word = ''; started = false }
    } else if ('$`;&|<>()'.includes(ch)) return false
    else if (ch === '\\') {
      const next = command[++index]
      if (next === undefined) return false
      word += next; started = true
    } else { word += ch; started = true }
  }
  if (quote) return false
  if (started) words.push(word)
  return words.length === 3 && ['bash', '/bin/bash', '/usr/bin/bash', 'sh', '/bin/sh'].includes(words[0])
    && ['-c', '-lc'].includes(words[1]) && words[2].trim() === expected.trim()
}

export function reviewDeliveryValidation(value, record) {
  const text = typeof value.reportText === 'string' ? value.reportText : ''
  return { text: typeof value.reportText === 'string', bytes: Buffer.byteLength(text) === value.reportBytes,
    digest: sha(text) === value.reportSha256, issue: text.includes('#1593'), source: text.includes(record.sourceCommit),
    ownerChoice: text.includes('owner_choice=provider-receipts'), evidence: text.includes('Evidence'),
    risks: text.includes('Risks'), limits: text.includes('Limits') }
}

/** Tool pairs only: ordinary assistant text cannot satisfy any native proof. */
export function nativeEvidence(detail, record) {
  const inputs = new Map(), pairs = []
  for (const [index, item] of (detail.chunks ?? []).entries()) {
    const chunk = item.chunk, id = chunk?.toolCallId
    if (typeof id !== 'string' || id.length > 500) continue
    const prefix = id.slice(0, 36)
    if (UUID.test(prefix) && id[36] === ':' && prefix !== record.runId) continue
    if (chunk.type === 'tool-input-available') {
      assert(!inputs.has(id), 'duplicate_native_tool_input')
      inputs.set(id, { index, chunk, at: item.at })
    } else if (chunk.type === 'tool-output-available' && inputs.has(id)) {
      const input = inputs.get(id)
      assert(!pairs.some(pair => pair.id === id), 'duplicate_native_tool_output')
      pairs.push({ id, input: input.chunk, inputAt: input.at, output: chunk.output, outputAt: item.at,
        inputIndex: input.index, outputIndex: index })
    }
  }
  const snapshots = {}
  for (const pair of pairs) {
    const name = pair.input.toolName?.toLowerCase()
    if (!['bash', 'shell'].includes(name)) continue
    const command = pair.input.input?.command
    const output = toolText(pair.output)
    if (!output || output.length > 20000) continue
    for (const line of output.split('\n').filter(value => value.startsWith(SNAPSHOT))) {
      let value
      try { value = JSON.parse(line.slice(SNAPSHOT.length)) } catch { continue }
      if (value.caseId !== record.caseId || !['before_question', 'after_answer', 'delivery'].includes(value.phase)) continue
      assert(isExactNativeCommand(command, nativeSnapshotCommand(record, value.phase)), 'native_command_mismatch')
      assert(!snapshots[value.phase], 'duplicate_native_snapshot')
      assert(SHA.test(value.head ?? '') && ['rootSha256', 'trackedSha256', 'statusSha256', 'markerSha256', 'reportSha256'].every(key => DIGEST.test(value[key] ?? ''))
        && value.markerSha256 === record.markerSha256 && value.markerBytes === record.markerBytes
        && Number.isSafeInteger(value.reportBytes) && value.reportBytes >= 300 && value.reportBytes <= 2400, 'native_snapshot_mismatch')
      if (value.phase === 'delivery') {
        // Retain closed diagnostics before throwing. A failed report must tell
        // integrity failures from missing content without exporting its text.
        record.deliveryValidation = reviewDeliveryValidation(value, record)
        assert(Object.values(record.deliveryValidation).every(Boolean), 'review_delivery_invalid')
      }
      snapshots[value.phase] = { phase: value.phase, head: value.head, rootSha256: value.rootSha256, trackedSha256: value.trackedSha256,
        statusSha256: value.statusSha256, markerSha256: value.markerSha256, markerBytes: value.markerBytes,
        reportSha256: value.reportSha256, reportBytes: value.reportBytes, toolCallHash: sha(pair.id).slice(0, 16), commandSha256: sha(command),
        observedAt: iso(Date.parse(pair.outputAt)), inputIndex: pair.inputIndex, outputIndex: pair.outputIndex }
    }
  }
  const asks = pairs.filter(pair => pair.input.toolName === 'mcp__mikka__ask_human'
    && pair.input.input?.kind === 'decision' && typeof pair.input.input.question === 'string'
    && pair.input.input.question.includes(record.caseId) && toolText(pair.output) !== null)
  assert(!pairs.some(pair => pair.input.toolName === 'mcp__mikka__submit'), 'unexpected_final_submission')
  return { snapshots, asks }
}

function promptFor(record, source) {
  const before = nativeSnapshotCommand(record, 'before_question')
  const after = nativeSnapshotCommand(record, 'after_answer')
  const delivery = nativeSnapshotCommand(record, 'delivery')
  return [
    `为 Mikka issue #1593 形成真正有用的生命周期验收审查报告。案例 ${record.caseId}，发布源 ${record.sourceCommit}。`,
    '这是非 repository 的普通 Factory 交付工作区；只在当前 canonical 工作目录创建下述报告与 marker。不要访问 HOME、秘密/环境变量、外部网络或其他目录，不创建新仓库、远程 repo、PR，不提交/推送 Git，不派发其他 agents。不要改配置或其他文件。',
    `先根据下面实际源代码摘录写 issue-1593-${record.caseId}.md 草稿，300–2400 UTF8 bytes，用简短英文减少编码开销。标题含 #1593 和完整发布源 SHA；包含 Evidence、Risks、Limits 小节，至少列出真实 native exit、provider pause ack 丢失、原 VM/SID 连续性及 checkpoint 清理边界。区分代码推断与实际观测，不能声称尚未执行的验收通过。`,
    '本任务的三段验证脚本各自必须独占一次原生 shell 工具调用：command 只能是给出的该段脚本全文。报告创建/修改必须使用另外的工具调用；不得把 cat/heredoc 写报告、cd、管道、其他前后命令或多个验证脚本拼进同一次调用。',
    '草稿完成后，原样执行以下原生 shell 命令。它仅建立本案例 marker，并记录当前 HEAD、已有 tracked 文件和状态的实际摘要：', before,
    `然后调用 Mikka 原生 ask_human，kind="decision"，question 必须含 ${record.caseId}；询问 Owner 本报告应优先深入 A) provider receipts / ambiguous pause，还是 B) stale epoch / execution lease；summary 简述已读源码与草稿。这个真正的报告重点由 Owner 决定，现在没有答案。调用后让本次 run 正常退出并等待，不调用 submit。`,
    'Owner 回答并在原 SID 续作后，第一项工作原样执行以下只读命令，证明 marker、原草稿与工作目录仍在：', after,
    '之后按 Owner 的真实选择完成同一报告，保留上述小节，并加入 Owner 提供的 owner_choice 行；最终文字仍为 300–2400 UTF8 bytes。不要重写 marker。报告应给出至少两个具体可证伪的验收建议及尚缺证据。再原样执行：', delivery,
    `最后调用第二个 ask_human(kind="decision")，question 含 ${record.caseId} 和 FINAL_REVIEW_READY，说明报告已经形成，但独立 review/check 阶段尚不能通过本次正常 API 锁定授权小模型，询问先补齐阶段授权还是结束本次审查。summary 给出报告发现。保持 waiting；本任务明确不授权调用 submit，因为 submit 会自动选择尚未固定的后继模型。`,
    `实际源摘录 ${source.path}（整个文件 SHA256 ${source.sha256}）：\n${source.excerpt}`,
  ].join('\n\n')
}

async function readMachine(client, record, scope, observeProvider, label, checkActive = () => {}) {
  const value = await client.rpc('agents.getThreadMachine', [record.issueId, record.runId])
  checkActive()
  const machine = value?.machine ?? value
  if (!machine?.cloud?.sandboxId) return null
  assert(machine.kind === 'cloud' && VM_ID.test(machine.cloud.sandboxId), 'machine_mapping_invalid')
  const sandboxId = machine.cloud.sandboxId
  assert(!record.sandboxId || record.sandboxId === sandboxId, 'vm_replaced')
  record.sandboxId ??= sandboxId
  record.correlation.vmHash = lifecycleHash('vm', sandboxId)
  record.machine = { state: machine.state, observedAt: new Date().toISOString(), evidence: 'owner_database_projection' }
  const expectedState = label.endsWith('_running') ? 'running' : 'paused'
  if (machine.state === expectedState && !record.provider[label]) {
    const observed = await observeProvider({ sandboxId, workspaceId: scope.workspaceId, originRunId: record.runId })
    checkActive()
    record.provider[label] = observed
  }
  return machine
}

async function factorySnapshot(client, record, hooks) {
  const listing = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
  hooks.checkActive()
  assert(listing.issueId === record.issueId && Array.isArray(listing.tasks), 'factory_scope_invalid')
  if (listing.liveWorkspaceId) hooks.watchScope(listing.liveWorkspaceId)
  if (!listing.tasks.length) return null
  assert(listing.tasks.length === 1 && listing.tasks[0].issueId === record.issueId && UUID.test(listing.tasks[0].id), 'factory_scope_invalid')
  const taskId = listing.tasks[0].id
  assert(!record.taskId || record.taskId === taskId, 'factory_task_changed')
  record.taskId = taskId
  record.correlation.taskHash = lifecycleHash('task', taskId)
  const snapshot = await client.json(`/api/factory/tasks/${taskId}`)
  hooks.checkActive()
  assert(snapshot.task?.id === taskId && snapshot.task.issueId === record.issueId, 'factory_scope_invalid')
  if (snapshot.liveWorkspaceId) hooks.watchScope(snapshot.liveWorkspaceId)
  for (const attempt of snapshot.attempts ?? []) if (UUID.test(attempt.runId ?? '')) {
    assert([record.runId, record.continuationRunId].includes(attempt.runId), 'unexpected_factory_attempt')
    hooks.watchRun(attempt.runId)
  }
  return snapshot
}

async function scopedQuestion(client, record, proof, { final = false, checkActive = () => {} } = {}) {
  const listing = await client.json(`/api/factory/questions?runId=${final ? record.continuationRunId : record.runId}`)
  checkActive()
  const candidates = (listing.questions ?? []).filter(item => item.type === 'decision' && item.question?.includes(record.caseId)
    && (!final || item.question.includes('FINAL_REVIEW_READY')))
  if (!candidates.length) return null
  assert(candidates.length === 1 && UUID.test(candidates[0].questionId), 'question_ambiguous')
  const question = await client.json(`/api/factory/questions/${candidates[0].questionId}`)
  checkActive()
  assert(question.id === candidates[0].questionId && question.taskId === record.taskId && question.issueId === record.issueId
    && question.originRunId === (final ? record.continuationRunId : record.runId)
    && ['open', 'waiting_user'].includes(question.status) && question.kind === 'decision'
    && question.reference?.originRunId === question.originRunId && question.reference.questionId === question.id
    && typeof question.originSessionId === 'string' && question.originSessionId.length > 0, 'question_binding_invalid')
  assert(proof.asks.length === 1 && proof.asks[0].input.input.question === question.question, 'native_question_missing')
  return question
}

/** Only this newly created issue and its Factory attempts are cleaned. No
 * version/abort fence is applied to cleanup, and audit history is retained. */
export async function cleanupLifecycleCase(client, record, { observeProvider, scope, now = Date.now } = {}) {
  const cleanup = record.cleanup = { status: 'running', errors: [], history: 'retained' }
  const runs = new Set([record.runId, record.continuationRunId].filter(Boolean))
  const step = async (name, work) => {
    try { await work(); return true } catch (error) { cleanup.errors.push({ step: name, code: safeError(error) }); return false }
  }
  if (record.issueId) {
    await step('factory_cancel', async () => {
      const list = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
      assert(list.issueId === record.issueId && Array.isArray(list.tasks), 'cleanup_scope_invalid')
      for (const item of list.tasks) {
        assert(item.issueId === record.issueId && UUID.test(item.id), 'cleanup_scope_invalid')
        const snapshot = await client.json(`/api/factory/tasks/${item.id}`)
        assert(snapshot.task?.issueId === record.issueId && snapshot.task.id === item.id, 'cleanup_scope_invalid')
        for (const attempt of snapshot.attempts ?? []) if (UUID.test(attempt.runId ?? '')) runs.add(attempt.runId)
        if (!['passed', 'cancelled', 'revoked'].includes(snapshot.task.status)) await client.json(`/api/factory/tasks/${item.id}`, post({
          binding: { taskId: item.id, revision: snapshot.task.revision }, eventId: randomUUID(), action: 'cancel',
          reason: 'Issue 1593 acceptance evidence retained; end only this owned case without authorizing another model.' }))
      }
    })
    await step('discover_case_runs', async () => {
      // Recover an accepted dispatch whose HTTP response was lost. One bounded
      // normal Owner read; no repeated business query or database polling.
      const listing = await client.rpc('agents.pollIssueThreads', [record.issueId])
      for (const thread of listing.threads ?? []) {
        assert(UUID.test(thread.id ?? '') && thread.ownedByCurrentUser === true, 'cleanup_scope_invalid')
        runs.add(thread.id)
      }
    })
    for (const runId of runs) {
      await step('run_stop', async () => {
        const detail = await client.rpc('agents.getIssueThread', [record.issueId, runId])
        assert(detail.thread?.id === runId, 'cleanup_scope_invalid')
        if (!TERMINAL.has(detail.thread.status)) {
          try { await client.rpc('agents.stopRun', [runId]) }
          catch (error) {
            const latest = await client.rpc('agents.getIssueThread', [record.issueId, runId])
            if (!TERMINAL.has(latest.thread?.status)) throw error
          }
        }
      })
      await step('machine_end', async () => {
        const receipt = await client.json(`/api/threads/${runId}/machine`, post({ action: 'end' }), 120000)
        assert(receipt.runId === runId && receipt.state === 'ended', 'cleanup_end_receipt_invalid')
        ;(cleanup.machineReceipts ??= []).push({ runId, state: 'ended', observedAt: iso(now()) })
      })
    }
    if (record.runId) await step('machine_end_readback', async () => {
      const value = await client.rpc('agents.getThreadMachine', [record.issueId, record.runId])
      const machine = value?.machine ?? value
      assert(machine?.kind === 'cloud' && machine.state === 'ended', 'cleanup_machine_not_ended')
      cleanup.databaseEndedAt = iso(now())
    })
    if (record.sandboxId && observeProvider) await step('provider_end_observation', async () => {
      cleanup.provider = await observeProvider({ sandboxId: record.sandboxId, workspaceId: scope.workspaceId, originRunId: record.runId })
      assert(cleanup.provider.status !== 'observed' || cleanup.provider.state === 'missing', 'cleanup_provider_still_present')
    })
  }
  // This POST can still commit after its response is lost. Empty task/thread
  // reads are not a receipt that no run will be queued; require an owned run's
  // exact end acknowledgement before treating an unacknowledged dispatch as clean.
  if (record.dispatchAttempted && !record.runId && !cleanup.machineReceipts?.length) {
    cleanup.errors.push({ step: 'dispatch_reconciliation', code: 'lifecycle_cleanup_dispatch_unconfirmed' })
  }
  if (record.botId) await step('coordinator_stop', () => client.rpc('coordinator.stopCoordinatorTurn', [record.botId]))
  cleanup.runIds = [...runs]
  cleanup.status = cleanup.errors.length ? 'failed' : 'passed'
}

function terminalObservation(detail, runId, now) {
  // The thread may project a whole continuation chain. Only the exact attempt
  // owns this completion timestamp; an absent timestamp never becomes a gate.
  const matches = Array.isArray(detail.thread?.attempts) ? detail.thread.attempts.filter(item => item.runId === runId) : []
  const attempt = matches.length === 1 ? matches[0] : null
  const status = TERMINAL.has(attempt?.status) ? attempt.status : null
  const finished = status && typeof attempt.finishedAt === 'string' ? Date.parse(attempt.finishedAt) : NaN
  return { runId, status, finishedAt: Number.isFinite(finished) ? iso(finished) : null,
    observedAt: iso(now()), source: 'normal_owner_thread_attempt' }
}

export async function runLifecycleCase({ client, botId, profile, scope, harness, sourceCommit, source, observeProvider, pin,
  caseId = randomUUID(), markerValue = randomUUID().replaceAll('-', ''), timeoutMs = 360000,
  WebSocketImpl = globalThis.WebSocket, now = Date.now, signal, wait = watchRun }) {
  assert(Object.hasOwn(MODELS, harness) && UUID.test(caseId) && SHA.test(sourceCommit), 'case_invalid')
  const markerBody = JSON.stringify({ caseId, sourceCommit, markerValue }) + '\n'
  const record = { caseId, harness, model: MODELS[harness], sourceCommit, botId, profileId: profile.id, startedAt: iso(now()),
    status: 'running', issueAcceptance: 'incomplete', phase: 'preflight', markerValue, markerSha256: sha(markerBody), markerBytes: Buffer.byteLength(markerBody),
    provider: {}, correlation: {}, terminal: { origin: null, continuation: null }, placement: { kind: 'cloud' },
    limits: ['automatic_next_stage_profile_not_pinned', 'markdown_download_not_tested'] }
  let originQuestion
  const fence = async () => { noAbort(signal); await pin(); noAbort(signal) }
  const waitPhase = async (runId, observe) => wait(client, { issueId: record.issueId, runId }, timeoutMs, WebSocketImpl, now, undefined, {
    allowTerminal: true, signal,
    matches: event => event.kind === 'factory_issue' && event.id === record.issueId
      || event.kind === 'factory_task' && event.id === record.taskId,
    observe,
  })
  try {
    await fence()
    const created = await client.rpc('issues.saveIssue', [{ title: `测试 1593 lifecycle review ${caseId} ${harness}`, status: 'todo', priority: 'low',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: promptFor(record, source) }] }] } }])
    assert(UUID.test(created.issue?.id ?? ''), 'issue_create_failed')
    record.issueId = created.issue.id
    await fence()
    record.dispatchAttempted = true
    const dispatch = await client.json(`/api/bots/${botId}/computer/runs`, post({ issueId: record.issueId, harness, profileId: profile.id,
      needsSpec: false, note: 'Complete the exact #1593 review/decision task in this issue. Keep both native decision boundaries; do not submit or start any additional stage.' }), 120000)
    assert(dispatch.thread === 'new' && UUID.test(dispatch.runId ?? ''), 'dispatch_not_new')
    record.runId = dispatch.runId
    record.correlation.runHash = lifecycleHash('run', record.runId)
    noAbort(signal)
    record.phase = 'waiting_for_native_question'
    await subscriptionProof(client, record, scope, profile)
    await waitPhase(record.runId, async (detail, hooks) => {
      noAbort(signal)
      if (TERMINAL.has(detail.thread?.status)) record.terminal.origin = terminalObservation(detail, record.runId, now)
      const snapshot = await factorySnapshot(client, record, hooks)
      const proof = nativeEvidence(detail, record)
      const machine = await readMachine(client, record, scope, observeProvider,
        TERMINAL.has(detail.thread?.status) ? 'before_answer' : 'origin_running', hooks.checkActive)
      if (!snapshot || !TERMINAL.has(detail.thread?.status)) return false
      const question = await scopedQuestion(client, record, proof, { checkActive: hooks.checkActive })
      if (!question) return false
      assert(proof.snapshots.before_question && proof.snapshots.before_question.outputIndex < proof.asks[0].inputIndex, 'pre_question_marker_missing')
      record.before = proof.snapshots.before_question
      if (machine?.state !== 'paused') return false
      assert(record.provider.before_answer?.status !== 'observed' || record.provider.before_answer.state === 'paused', 'provider_pause_mismatch')
      originQuestion = question
      record.questionId = question.id
      record.originSessionHash = lifecycleHash('session', question.originSessionId)
      record.nativeQuestion = { status: 'proved', questionHash: sha(question.question), observedAt: iso(now()) }
      return true
    })
    await fence()
    record.phase = 'owner_answer'
    const answerId = randomUUID()
    const answered = await client.json(`/api/factory/questions/${record.questionId}`, post({ reference: originQuestion.reference, answerId,
      text: '选择 A：优先审查 provider receipts / ambiguous pause。报告加入 owner_choice=provider-receipts；清楚区分真实 provider 确认与数据库投影，给出丢失 pause 响应与原 SID 续作的可证伪验收建议。完成报告后按原任务要求发 FINAL_REVIEW_READY decision，仍不授权最终 submit 或任何独立后继模型。' }), 120000)
    assert(UUID.test(answered.continuationRunId ?? '') && answered.continuationRunId !== record.runId, 'continuation_missing')
    record.continuationRunId = answered.continuationRunId
    record.answer = { id: answerId, source: 'normal_owner_session', observedAt: iso(now()) }
    record.correlation.continuationRunHash = lifecycleHash('run', record.continuationRunId)
    noAbort(signal)
    const continuation = { issueId: record.issueId, runId: record.continuationRunId, harness, profileId: profile.id, placement: { kind: 'cloud' } }
    await subscriptionProof(client, continuation, scope, profile)
    record.continuationExecution = continuation.execution
    record.phase = 'waiting_for_same_session_delivery'
    await waitPhase(record.continuationRunId, async (detail, hooks) => {
      noAbort(signal)
      if (TERMINAL.has(detail.thread?.status)) record.terminal.continuation = terminalObservation(detail, record.continuationRunId, now)
      const snapshot = await factorySnapshot(client, record, hooks)
      const proof = nativeEvidence(detail, { ...record, runId: record.continuationRunId })
      const machine = await readMachine(client, record, scope, observeProvider, TERMINAL.has(detail.thread?.status) ? 'after_delivery' : 'resumed_running', hooks.checkActive)
      if (!snapshot || !TERMINAL.has(detail.thread?.status)) return false
      const question = await client.json(`/api/factory/questions/${record.questionId}`)
      hooks.checkActive()
      if (question.status !== 'resolved') {
        assert(['answered', 'resuming'].includes(question.status), 'question_resume_failed')
        return false
      }
      assert(question.originSessionId === originQuestion.originSessionId && question.continuationRunId === record.continuationRunId, 'session_binding_changed')
      const attempt = snapshot.attempts?.find(item => item.runId === record.continuationRunId)
      if (!attempt?.sessionId) return false
      assert(attempt.sessionId === originQuestion.originSessionId, 'native_session_changed')
      const finalQuestion = await scopedQuestion(client, record, proof, { final: true, checkActive: hooks.checkActive })
      if (!finalQuestion) return false
      if (machine?.state !== 'paused') return false
      assert(record.provider.after_delivery?.status !== 'observed' || record.provider.after_delivery.state === 'paused', 'provider_pause_mismatch')
      const after = proof.snapshots.after_answer, delivery = proof.snapshots.delivery
      assert(after && delivery && after.outputIndex < delivery.inputIndex && delivery.outputIndex < proof.asks[0].inputIndex, 'delivery_native_order_invalid')
      assert(['head', 'rootSha256', 'trackedSha256', 'statusSha256', 'markerSha256', 'markerBytes', 'reportSha256', 'reportBytes']
        .every(key => record.before[key] === after[key]), 'workspace_continuity_failed')
      assert(delivery.head === after.head && delivery.rootSha256 === after.rootSha256 && delivery.trackedSha256 === after.trackedSha256, 'unexpected_tracked_file_change')
      record.after = after; record.delivery = { ...delivery, evidence: 'native_shell_transcript', finalSubmission: 'blocked_unpinned_next_stage_profile' }
      record.pendingFinalQuestionId = finalQuestion.id
      record.session = { status: 'proved', originSessionHash: record.originSessionHash,
        actualContinuationSessionHash: lifecycleHash('session', attempt.sessionId), questionStatus: question.status }
      const changes = await client.rpc('agents.getThreadChanges', [record.issueId, record.continuationRunId])
      hooks.checkActive()
      const paths = changes.changes?.files?.map(file => file.path).sort()
      const expected = [`issue-1593-${caseId}.marker`, `issue-1593-${caseId}.md`].sort()
      assert(changes.state === 'ready' && JSON.stringify(paths) === JSON.stringify(expected)
        && changes.changes.files.every(file => !file.binary && !file.previousPath && file.additions > 0), 'delivery_checkpoint_unavailable')
      record.checkpoint = { status: 'observed', scope: 'latest_chain_checkpoint_not_independently_run_bound', files: paths,
        projectionSha256: sha(JSON.stringify(changes.changes)), observedAt: iso(now()) }
      return true
    })
    await fence()
    record.phase = 'evidence_complete_pending_final_stage_authorization'
    record.dimensions = { nativeQuestion: 'proved', ownerAnswer: 'proved', ownerVmMapping: 'same_id_observed',
      originalVm: record.provider.before_answer?.status === 'observed' && record.provider.after_delivery?.status === 'observed'
        && record.provider.before_answer.ownershipVerified && record.provider.after_delivery.ownershipVerified ? 'proved' : 'blocked', originalSid: 'proved',
      markerAndDraftContinuity: 'proved', nativeFinalReport: 'proved', uploadedCheckpointProjection: 'observed',
      providerPause: record.provider.before_answer?.state === 'paused' ? 'proved' : 'blocked',
      providerResumeRunning: record.provider.resumed_running?.state === 'running' ? 'observed' : 'unobserved',
      providerFinalPause: record.provider.after_delivery?.state === 'paused' ? 'proved' : 'blocked',
      finalFactorySubmission: 'blocked_unpinned_next_stage_profile' }
    // A short genuine continuation can finish before a static running sample.
    // Its actual same-SID native execution and unchanged workspace, bounded by
    // two positive observations of the same paused VM, prove the resumption.
    // No precise resume instant or directly sampled running state is inferred.
    record.resume = { status: record.dimensions.originalVm === 'proved' ? 'proved' : 'blocked', source: 'native_execution_same_vm',
      runningObservation: record.provider.resumed_running?.state === 'running' ? 'observed' : 'unobserved' }
    record.missingEvidence = ['before_answer', 'after_delivery'].filter(key => record.provider[key]?.status !== 'observed'
      || record.provider[key]?.state !== 'paused').map(key => `provider_${key}`)
    record.status = record.missingEvidence.length ? 'partial' : 'passed'
  } catch (error) { record.error = safeError(error); record.status = record.runId ? 'failed' : 'blocked' }
  finally {
    // Marker entropy is task data, not needed in the exported evidence.
    delete record.markerValue
    await cleanupLifecycleCase(client, record, { observeProvider, scope, now })
    if (record.cleanup.status !== 'passed') record.status = 'failed'
    else if (record.status === 'passed' && record.cleanup.provider?.state !== 'missing') {
      record.status = 'partial'; (record.missingEvidence ??= []).push('provider_end_confirmation')
    }
    record.finishedAt = iso(now())
  }
  return record
}

async function archiveOwnedProfile(client, receipt, workspaceId) {
  if (receipt.cleaned) return
  if (!receipt.version) {
    // The normal idempotent create contract makes profile.id=requestId. A
    // lost POST response therefore has one exact owned identifier to recover.
    const response = await client.request(`/api/factory/agent-profiles/${receipt.id}?workspaceId=${workspaceId}`)
    if (response.status === 404) { receipt.cleaned = true; return }
    assert(response.ok, 'profile_cleanup_read_failed')
    const value = await response.json()
    assert(value.profile?.id === receipt.id && Number.isSafeInteger(value.profile.version) && value.profile.version > 0, 'profile_cleanup_scope_invalid')
    if (value.profile.archivedAt) { receipt.cleaned = true; return }
    receipt.version = value.profile.version
  }
  const archived = await client.json(`/api/factory/agent-profiles/${receipt.id}`, {
    ...post({ workspaceId, version: receipt.version }), method: 'DELETE' })
  assert(archived.profile?.id === receipt.id && Number.isFinite(Date.parse(archived.profile.archivedAt ?? '')), 'profile_archive_receipt_invalid')
  receipt.cleaned = true
}

export async function runThreadLifecycle(options, { env = process.env, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket,
  now = Date.now, signal, readSource = pinnedSources, getInfo = async (...args) => (await import('e2b')).Sandbox.getInfo(...args),
  createClient = createSessionClient, runCase = runLifecycleCase } = {}) {
  const report = { schemaVersion: 1, issue: 1593, sourceCommit: options.sourceCommit, origin: ORIGIN, fixtureId: randomUUID(),
    startedAt: iso(now()), status: 'running', issueAcceptance: 'incomplete', cases: [], cleanup: { status: 'running', errors: [] },
    scope: 'real_owner_factory_question_pause_resume_with_native_report',
    pending: ['external_wait_and_adjacent_stage_continuity', 'terminal_revoke_and_close_grace_retention',
      'provider_timeout_fault_injection', 'latency_and_cost_measurement'],
    excluded: ['provider_fault_injection_separate_driver', 'natural_timeout_expiry', 'markdown_download', 'automatic_final_stage_model_selection',
      'final_factory_submission', 'independent_coding_stage_completion'] }
  const client = createClient(ORIGIN, fetchImpl), profiles = [], bots = new Set()
  let loggedIn = false, ownerId, originalWorkspaceId, scope, phase = 'runtime_validation'
  const pin = async () => {
    noAbort(signal)
    const priorPhase = phase
    phase = 'build_pin'
    const version = await client.json('/api/version')
    noAbort(signal)
    assert(version.build === options.sourceCommit, 'production_source_mismatch')
    report.build = version.build
    phase = priorPhase
  }
  const observeProvider = createProviderObserver({ apiKey: env.E2B_API_KEY, getInfo, now })
  try {
    assert(SHA.test(options.sourceCommit ?? '') && typeof WebSocketImpl === 'function', 'runtime_invalid')
    phase = 'source_pin'
    const source = await readSource(options.sourceCommit)
    report.source = { path: source.path, sha256: source.sha256 }
    phase = 'account_validation'
    const account = smokeAcceptanceAccount(env)
    await pin()
    phase = 'sign_in'
    const login = await client.request('/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    assert(login.ok, 'sign_in_failed'); loggedIn = true
    phase = 'session_identity'
    const identity = await client.json('/api/auth/get-session')
    assert(identity.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof identity.user.id === 'string' && identity.user.id.length > 0, 'session_identity_mismatch')
    ownerId = identity.user.id
    report.ownerHash = lifecycleHash('owner', ownerId)
    phase = 'workspace_selection'
    scope = await selectAcceptanceTeam(client, { ownerId }, value => { originalWorkspaceId = value })
    report.team = scope.evidence
    phase = 'subscription_catalogue'
    const order = await client.rpc('model-order.getModelOrder', [scope.workspaceId])
    phase = 'owner_cloud_capability'
    const keyStatus = await client.rpc('workspace-secrets.getE2BKeyCapability', [scope.workspaceId])
    assert(typeof keyStatus.configured === 'boolean' && typeof keyStatus.byoEnabled === 'boolean', 'owner_cloud_status_invalid')
    report.ownerCloud = { configured: keyStatus.configured, byoEnabled: keyStatus.byoEnabled,
      lastErrorCode: ['invalid', 'rate_limited', 'unavailable'].includes(keyStatus.lastErrorCode) ? keyStatus.lastErrorCode : null,
      observedAt: iso(now()), source: 'normal_owner_status_no_key_value' }
    for (const [harness, model] of Object.entries(MODELS)) {
      phase = 'subscription_selection'
      if (report.cases.some(item => item.cleanup.status !== 'passed')) {
        report.cases.push({ harness, model, status: 'blocked', error: 'lifecycle_previous_cleanup_unconfirmed',
          cleanup: { status: 'passed', errors: [], history: 'no_case_created' } })
        continue
      }
      const candidates = (order.candidates ?? []).filter(item => item.harness === harness && item.model === model
        && item.source?.kind === 'subscription' && UUID.test(item.source.connectionId ?? '') && item.credentialOwnerId === scope.adminId)
      const unavailable = candidates.length !== 1 ? 'shared_subscription_missing_or_ambiguous'
        : !keyStatus.configured || !keyStatus.byoEnabled ? 'owner_cloud_key_not_configured' : null
      if (unavailable) {
        report.cases.push({ harness, model, status: 'blocked', error: `lifecycle_${unavailable}`, subscription: { available: candidates.length === 1 },
          cleanup: { status: 'passed', errors: [], history: 'no_case_created' } })
        continue
      }
      let caseReport, fixture, profileReceipt, setupPhase = 'none'
      try {
        await pin()
        // A separate unique Bot per leg also isolates each canonical deliverable
        // workspace. No pre-existing Bot or workspace model preference changes.
        setupPhase = 'bot_create'
        phase = 'bot_create'
        fixture = await acceptanceBot(client, undefined, randomUUID(), { issue: 1593,
          rememberCreated: botId => { bots.add(botId); fixture = { botId, created: true, retention: 'retained_no_delete_api', validation: 'unconfirmed' } } })
        const caseScope = { ...scope, botId: fixture.botId }
        setupPhase = 'new_bot_model_choice'
        await pin()
        phase = 'chat_model_selection'
        await chooseSharedChatModel(client, fixture.botId, harness)
        // This is the new Bot's ordinary Coordinator preference. The coding
        // leg itself is separately pinned and proved by its frozen Profile.
        await pin()
        setupPhase = 'profile_create'
        phase = 'profile_create'
        profileReceipt = { id: randomUUID(), version: null, cleaned: false }
        profiles.push(profileReceipt)
        const created = await client.json('/api/factory/agent-profiles', post({ workspaceId: scope.workspaceId, requestId: profileReceipt.id, profile: {
          name: `测试1593 ${report.fixtureId.slice(0, 8)} ${harness}`, description: 'Issue 1593 lifecycle review; native decision boundaries; no final automatic stages.', enabled: true,
          harness, model: { mode: 'fixed', harness, model, source: candidates[0].source }, effort: 'low', roles: [], skills: [],
          instructions: 'Use only this fixed official subscription for the assigned lifecycle review. Do not submit: final submission selects an unpinned independent Profile. Complete the two actual decision boundaries and retain the useful report in the canonical workspace. No extra agents, credentials, configuration changes, remote repos, commits or PRs.',
        } }))
        phase = 'profile_validation'
        const profile = created.profile
        if (profile?.id === profileReceipt.id && Number.isSafeInteger(profile.version) && profile.version > 0) profileReceipt.version = profile.version
        assert(profile?.id === profileReceipt.id && Number.isSafeInteger(profile.version) && profile.version > 0 && DIGEST.test(profile.digest ?? '')
          && profile.harness === harness && profile.model?.mode === 'fixed' && profile.model.harness === harness && profile.model.model === model
          && profile.model.source?.kind === 'subscription' && profile.model.source.connectionId === candidates[0].source.connectionId, 'profile_source_mismatch')
        setupPhase = 'run_case'
        phase = 'run_case'
        caseReport = await runCase({ client, botId: fixture.botId, profile, scope: caseScope, harness, sourceCommit: options.sourceCommit, source,
          observeProvider, pin, timeoutMs: options.timeoutMs, WebSocketImpl, now, signal })
        assert(caseReport?.cleanup && ['passed', 'failed'].includes(caseReport.cleanup.status), 'cleanup_receipt_missing')
      } catch (error) {
        let profileCleanupError
        if (setupPhase === 'profile_create' && profileReceipt) {
          try { await archiveOwnedProfile(client, profileReceipt, scope.workspaceId) }
          catch (cleanupError) { profileCleanupError = safeError(cleanupError) }
        }
        const unknown = setupPhase === 'run_case' || setupPhase === 'bot_create' && !fixture
          || setupPhase === 'profile_create' && !profileReceipt?.cleaned
        const failure = failureAt(error, phase)
        caseReport = { harness, model, status: unknown ? 'failed' : 'blocked', error: failure.code, failure, setupPhase,
          cleanup: { status: unknown ? 'failed' : 'passed', scope: 'setup_only_no_confirmed_task_dispatch',
            errors: unknown ? [{ step: setupPhase, code: profileCleanupError ?? 'lifecycle_cleanup_receipt_missing' }] : [] } }
      }
      if (fixture) caseReport.bot = { id: fixture.botId, retention: fixture.retention, ...(fixture.validation ? { validation: fixture.validation } : {}) }
      if (profileReceipt) caseReport.profileId = profileReceipt.id
      report.cases.push(caseReport)
    }
  } catch (error) { report.failure = failureAt(error, phase); report.error = report.failure.code }
  finally {
    const clean = async (step, work) => { try { await work() } catch (error) { report.cleanup.errors.push({ step, code: safeError(error) }) } }
    if (loggedIn) {
      for (const botId of bots) await clean('coordinator_stop', () => client.rpc('coordinator.stopCoordinatorTurn', [botId]))
      for (const profile of profiles) await clean('profile_archive', () => archiveOwnedProfile(client, profile, scope.workspaceId))
      if (originalWorkspaceId) await clean('workspace_restore', async () => {
        await restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = true
      })
      await clean('sign_out', async () => { const response = await client.request('/api/auth/sign-out', post({})); assert(response.ok, 'sign_out_failed') })
    }
    client.clear()
    for (const [harness, model] of Object.entries(MODELS)) if (!report.cases.some(item => item.harness === harness))
      report.cases.push({ harness, model, status: 'blocked', error: report.error ?? 'lifecycle_precondition_failed',
        ...(report.failure ? { failure: { ...report.failure } } : {}), cleanup: { status: 'passed', errors: [] } })
    report.cleanup.status = report.cleanup.errors.length || report.cases.some(item => item.cleanup.status !== 'passed') ? 'failed' : 'passed'
    report.status = report.cleanup.status === 'failed' || report.cases.some(item => item.status === 'failed') ? 'failed'
      : report.cases.every(item => item.status === 'blocked') ? 'blocked'
        : report.error || report.cases.some(item => item.status !== 'passed') ? 'partial' : 'passed'
    report.finishedAt = iso(now())
  }
  return report
}

async function main() {
  let options
  try { assert(process.argv.length === 2, 'arguments_not_supported'); options = readOptions() }
  catch (error) { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; return }
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGTERM', abort); process.once('SIGINT', abort)
  try {
    const report = await runThreadLifecycle(options, { signal: controller.signal })
    await mkdir(dirname(options.reportPath), { recursive: true, mode: 0o700 })
    const temporary = `${options.reportPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, options.reportPath)
    process.stdout.write(JSON.stringify({ status: report.status, issueAcceptance: report.issueAcceptance, scope: report.scope, sourceCommit: report.sourceCommit,
      cases: report.cases.map(item => ({ harness: item.harness, status: item.status })), cleanup: report.cleanup.status }) + '\n')
    if (report.status !== 'passed' || controller.signal.aborted) process.exitCode = 1
  } catch (error) { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1 }
  finally { process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
