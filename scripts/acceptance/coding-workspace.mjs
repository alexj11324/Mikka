/** #1721: two ordinary subscription tasks, observed through the public Files API.
 * No provider/VM APIs, credential reads, model retries, sleeps or source artifacts.
 * The caller attests the release and owns writing this closed evidence report.
 */
import { createHash, randomUUID } from 'node:crypto'
import { runWorktreeIdentity, workspaceReadResult } from '@mikka/protocol/coding-workspace'
import { runCloudStartup, startupFailure, validatePersonalOptions } from './cloud-startup.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const REPOSITORY = 'alexj11324/Mikka-handoff'
const REPOSITORY_KEY = 'v2/github.com/alexj11324/mikka-handoff'
const MODELS = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled', 'paused'])
const CODES = new Set(['options_invalid', 'acceptance_aborted', 'team_unavailable', 'fixture_invalid', 'run_scope_mismatch',
  'active_window_missed', 'native_shell_unavailable', 'native_tool_receipt_missing', 'native_tool_invalid', 'native_worker_mismatch',
  'native_file_mismatch', 'files_api_refused', 'files_response_invalid', 'files_identity_mismatch', 'files_revision_mismatch',
  'files_observation_invalid', 'files_range_mismatch', 'files_hash_mismatch', 'mention_invalid', 'release_unconfirmed',
  'release_denial_missing', 'fixture_delete_failed', 'execution_unproved', 'cleanup_failed', 'acceptance_failed'])
const OPERATIONS = new Set(['teams', 'issue_create', 'policy', 'identity', 'tree', 'search', 'file', 'mention_create', 'mention_resolve',
  'window_status', 'window_machine', 'released_identity', 'released_file', 'released_mention', 'issue_read', 'issue_delete'])
const hash = value => createHash('sha256').update(value).digest('hex')
const iso = value => new Date(value).toISOString()
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(`coding_workspace_${code}`), { code }) }
const errorCode = error => CODES.has(error?.code) ? error.code : 'acceptance_failed'
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

async function drainRequests(promises) {
  const results = await Promise.allSettled(promises)
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  return results.map(result => result.value)
}

export function readOptions(env = process.env) {
  const options = { sourceCommit: env.EXPECTED_SOURCE_SHA, workerSha: env.EXPECTED_WORKER_SHA, workerSourceCommit: env.EXPECTED_WORKER_SOURCE_SHA }
  check(Object.values(options).every(value => SHA.test(value ?? '')), 'options_invalid')
  if (env.MIKKA_ACCEPTANCE_WORKSPACE_KIND) {
    check(['personal', 'team'].includes(env.MIKKA_ACCEPTANCE_WORKSPACE_KIND), 'options_invalid')
    if (env.MIKKA_ACCEPTANCE_WORKSPACE_KIND === 'personal') {
      Object.assign(options, { workspaceKind: 'personal', workspace: env.MIKKA_ACCEPTANCE_WORKSPACE_ID,
        operation: env.MIKKA_ACCEPTANCE_OPERATION ?? 'readiness', harness: env.MIKKA_ACCEPTANCE_HARNESS ?? 'both',
        deviceId: env.MIKKA_ACCEPTANCE_DEVICE_ID, agentId: env.MIKKA_ACCEPTANCE_AGENT_ID,
        origin: env.MIKKA_ACCEPTANCE_BASE_URL ?? ORIGIN })
    }
  }
  return options
}

/** The exact command is matched against a native shell input, not model prose.
 * Its run ID comes from the fresh daemon worktree; release identity comes only
 * from root-owned installed files. Neither expected SHA is embedded in it.
 */
export function nativeProbeCommand(sampleId, harness) {
  check(/^[A-Za-z0-9_-]{1,80}$/.test(sampleId ?? '') && Object.hasOwn(MODELS, harness), 'fixture_invalid')
  return `python3 -I -B - <<'MIKKA_FILES_PROBE'
import datetime, hashlib, json, os, pathlib, re, stat, subprocess, sys
case_id = ${JSON.stringify(sampleId)}
harness = ${JSON.stringify(harness)}
try:
    def git(*args):
        result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args], capture_output=True, text=True, timeout=10)
        if result.returncode != 0: raise ValueError('git')
        return result.stdout.strip()
    root = pathlib.Path(git('rev-parse', '--show-toplevel')).resolve(strict=True)
    run_id = root.name
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id): raise ValueError('run')
    if git('symbolic-ref', '--short', 'HEAD') != 'mikka/run-' + run_id: raise ValueError('branch')
    head = git('rev-parse', '--verify', 'HEAD')
    if not re.fullmatch(r'[a-f0-9]{40}', head): raise ValueError('head')
    remote = git('config', '--get', 'remote.origin.url')
    if not re.fullmatch(r'(?:https://github[.]com/|git@github[.]com:|ssh://git@github[.]com/)alexj11324/Mikka-handoff(?:[.]git)?', remote, re.I): raise ValueError('remote')
    marker = '/opt/mikka/worker-source-sha'
    fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        marker_stat = os.fstat(stream.fileno())
        worker_sha = stream.read(128).decode('ascii').strip()
    if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_uid != 0 or marker_stat.st_mode & 0o222 or os.access(marker, os.W_OK): raise ValueError('marker')
    source = pathlib.Path('/opt/mikka/worker').resolve(strict=True)
    source_match = re.fullmatch(r'/opt/mikka/releases/([a-f0-9]{40})/source', str(source))
    source_stat = source.stat()
    if not source_match or not stat.S_ISDIR(source_stat.st_mode) or source_stat.st_uid != 0 or os.access(source, os.W_OK): raise ValueError('source')
    if not re.fullmatch(r'[a-f0-9]{40}', worker_sha): raise ValueError('worker')
    fd = os.open(root / 'README.md', os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > 1048576: raise ValueError('file')
        contents = stream.read(1048577)
        after = os.fstat(stream.fileno())
    if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(contents) != before.st_size: raise ValueError('changed')
    lines = contents.decode('utf-8').split('\\n')
    selected = '\\n'.join(lines[:20]).encode('utf-8')
    if git('rev-parse', '--verify', 'HEAD') != head or pathlib.Path('/opt/mikka/worker').resolve(strict=True) != source: raise ValueError('changed')
    receipt = dict(version=1, status='passed', caseId=case_id, harness=harness, runId=run_id, repositoryKey='${REPOSITORY_KEY}', headSha=head,
        workerSha=worker_sha, workerSourceCommit=source_match.group(1), markerUid=marker_stat.st_uid, markerMode=stat.S_IMODE(marker_stat.st_mode),
        markerWritable=False, sourceUid=source_stat.st_uid, sourceWritable=False, path='README.md', size=len(contents),
        contentSha256=hashlib.sha256(contents).hexdigest(), selectedSha256=hashlib.sha256(selected).hexdigest(),
        startLine=1, endLine=min(20, len(lines)), totalLines=len(lines), observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    print('MIKKA_FILES_PROBE=' + json.dumps(receipt, separators=(',', ':')))
except Exception:
    print('MIKKA_FILES_PROBE=' + json.dumps(dict(version=1, status='probe_failed', caseId=case_id, harness=harness), separators=(',', ':')))
    sys.exit(1)
MIKKA_FILES_PROBE`
}

function commandMatches(actual, expected) {
  if (actual === expected) return true
  // Codex can expose the native shell's argv rendering. Only these complete
  // literal wrappers are equivalent; added commands/echoes never match.
  const quoted = `'${expected.replaceAll("'", "'\\''")}'`
  return ['/bin/bash', '/bin/sh', 'bash', 'sh'].some(shell => actual === `${shell} -lc ${quoted}` || actual === `${shell} -c ${quoted}`)
}

export function assertRunScope(detail, record) {
  const thread = detail?.thread
  check(thread?.id === record.runId && thread.rootRunId === record.runId && thread.latestRunId === record.runId
    && thread.ownedByCurrentUser === true && !thread.continuation && thread.attempts?.length === 1
    && thread.attempts[0].runId === record.runId && thread.detail?.harness === record.harness, 'run_scope_mismatch')
}

/** The public detail contains one exact run, with paired native input/output.
 * A text delta, tool output without its real input, or another attempt is inert.
 */
export function nativeReceipt(detail, record, options) {
  assertRunScope(detail, record)
  const command = nativeProbeCommand(record.sampleId, record.harness)
  const inputs = new Map(), receipts = []
  let started = false
  for (const item of detail.chunks ?? []) {
    const chunk = item.chunk
    if (chunk?.type === 'data-run-stage' && chunk.data?.stage === 'agent_start' && chunk.data.ok === true) started = true
    if (!started) continue
    if (chunk?.type === 'tool-input-available' && chunk.toolName === (record.harness === 'codex' ? 'bash' : 'Bash')
      && commandMatches(chunk.input?.command, command)) {
      check(typeof chunk.toolCallId === 'string' && chunk.toolCallId.length <= 512 && !inputs.has(chunk.toolCallId)
        && validTime(item.at), 'native_tool_invalid')
      inputs.set(chunk.toolCallId, item.at)
    }
    if (chunk?.type !== 'tool-output-available' || !inputs.has(chunk.toolCallId)) continue
    const text = record.harness === 'codex' ? chunk.output?.exitCode === 0 ? chunk.output.output : null : chunk.output
    check(typeof text === 'string' && text.length < 4000 && validTime(item.at), 'native_tool_invalid')
    const match = /^MIKKA_FILES_PROBE=(\{[^\n]+\})\s*$/.exec(text)
    check(match, 'native_tool_invalid')
    let value
    try { value = JSON.parse(match[1]) } catch (cause) { throw Object.assign(new Error('coding_workspace_native_tool_invalid', { cause }), { code: 'native_tool_invalid' }) }
    const keys = ['version', 'status', 'caseId', 'harness', 'runId', 'repositoryKey', 'headSha', 'workerSha', 'workerSourceCommit',
      'markerUid', 'markerMode', 'markerWritable', 'sourceUid', 'sourceWritable', 'path', 'size', 'contentSha256', 'selectedSha256',
      'startLine', 'endLine', 'totalLines', 'observedAt']
    check(same(Object.keys(value).sort(), keys.sort()) && value.version === 1 && value.status === 'passed'
      && value.caseId === record.sampleId && value.harness === record.harness && value.runId === record.runId
      && value.repositoryKey === REPOSITORY_KEY && value.path === 'README.md' && SHA.test(value.headSha)
      && HASH.test(value.contentSha256) && HASH.test(value.selectedSha256)
      && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 1048576
      && value.startLine === 1 && Number.isSafeInteger(value.totalLines) && value.totalLines > 0
      && value.endLine === Math.min(20, value.totalLines), 'native_tool_invalid')
    check(value.workerSha === options.workerSha && value.workerSourceCommit === options.workerSourceCommit
      && value.markerUid === 0 && Number.isSafeInteger(value.markerMode) && value.markerMode >= 0 && value.markerMode <= 0o777
      && (value.markerMode & 0o222) === 0 && value.markerWritable === false && value.sourceUid === 0 && value.sourceWritable === false,
    'native_worker_mismatch')
    const inputAt = Date.parse(inputs.get(chunk.toolCallId)), outputAt = Date.parse(item.at), observedAt = Date.parse(value.observedAt)
    check(validTime(value.observedAt) && outputAt >= inputAt && observedAt >= inputAt - 5000 && observedAt <= outputAt + 5000, 'native_tool_invalid')
    receipts.push({ ...value, commandSha256: hash(command), toolCallHash: hash(chunk.toolCallId), inputAt: inputs.get(chunk.toolCallId), outputAt: item.at })
  }
  check(inputs.size <= 1 && receipts.length <= 1, 'native_tool_invalid')
  return receipts[0] ?? null
}

const identityView = value => ({ version: value.version, runId: value.runId, repoId: value.repoId, deviceId: value.deviceId,
  workspaceId: value.workspaceId, ownerHash: hash(value.ownerId), repositoryKey: value.repositoryKey, bindingId: value.bindingId })
const revisionView = value => ({ source: value.source, headSha: value.headSha, baseSha: value.baseSha, version: value.version })
const fileView = value => ({ path: value.path, size: value.size, contentSha256: value.contentSha256, selectedSha256: hash(value.content),
  startLine: value.startLine, endLine: value.endLine, totalLines: value.totalLines, truncated: value.truncated,
  revision: revisionView(value.revision), observedAt: value.observedAt })

export function createWorkspaceProbe(options, { client, record, scope, now = Date.now, signal }) {
  const evidence = record.codingWorkspace = { status: 'running', requests: [] }
  let attempted = false, identity, file, mentionId, native
  const active = () => check(!signal?.aborted, 'acceptance_aborted')
  const rememberFailure = error => { evidence.status = 'failed'; evidence.failure ??= errorCode(error); throw error }
  const timed = async (operation, work) => {
    const entry = { operation, startedAt: iso(now()), outcome: 'running' }
    evidence.requests.push(entry)
    try { const value = await work(entry); entry.outcome = 'passed'; return value }
    catch (error) { entry.outcome = 'failed'; throw error }
    finally { entry.finishedAt = iso(now()); entry.ms = Math.max(0, Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)) }
  }
  const rpc = (operation, action, args) => timed(operation, () => client.rpc(action, args))
  const request = (operation, path, init, denial = false) => timed(operation, async entry => {
    const response = await client.request(path, init)
    entry.httpStatus = response.status
    let body
    try { body = await response.json() } catch (cause) { throw Object.assign(new Error('coding_workspace_files_response_invalid', { cause }), { code: 'files_response_invalid' }) }
    if (denial) {
      // A real typed unavailable receipt, after release, while the issue is
      // still visible. Login failures, missing routes and timeouts never pass.
      const denied = response.status === 409 && same(body, { ok: false, code: 'workspace_machine_unavailable' })
        // Normal machine retirement revokes the device/token, so the identity
        // resolver can no longer join that formerly authorized binding.
        || response.status === 404 && same(body, { ok: false, code: 'workspace_not_found' })
      check(denied, 'release_denial_missing')
      return { code: body.code, httpStatus: response.status, observedAt: iso(now()) }
    }
    if (!response.ok || body?.ok === false) {
      if (body?.code === 'workspace_machine_unavailable') {
        const [detail, machine] = await drainRequests([
          rpc('window_status', 'agents.getIssueThread', [record.issueId, record.runId]),
          rpc('window_machine', 'agents.getThreadMachine', [record.issueId, record.runId]),
        ])
        assertRunScope(detail, record)
        check(!TERMINAL.has(detail.thread.status) && !['paused', 'ended'].includes(machine?.state), 'active_window_missed')
      }
      check(false, 'files_api_refused')
    }
    if (body.observedAt) check(validTime(body.observedAt) && Date.parse(body.observedAt) >= Date.parse(entry.startedAt) - 5000
      && Date.parse(body.observedAt) <= now() + 5000, 'files_observation_invalid')
    return body
  })
  const base = () => `/api/runs/${record.runId}/workspace`
  const fileURL = values => `${base()}/files?${new URLSearchParams({ workspaceId: scope.workspaceId, repoId: identity.repoId, ...values })}`
  const validateRead = (value, kind) => {
    const parsed = workspaceReadResult.safeParse(value)
    check(parsed.success && parsed.data.ok && parsed.data.kind === kind && parsed.data.availability === 'online', 'files_response_invalid')
    check(same(parsed.data.identity, identity), 'files_identity_mismatch')
    check(parsed.data.revision.source === 'working' && SHA.test(parsed.data.revision.headSha), 'files_revision_mismatch')
    return parsed.data
  }
  const validateFile = value => {
    const result = validateRead(value, 'file')
    check(result.path === 'README.md' && result.format === 'text' && result.content !== null && HASH.test(result.contentSha256 ?? '')
      && result.editable === false && result.startLine === 1 && result.endLine === Math.min(20, result.totalLines)
      && result.content.split('\n').length === result.endLine && result.truncated === (result.endLine < result.totalLines), 'files_range_mismatch')
    check(result.revision.version === hash(`${result.revision.headSha}:README.md:${result.contentSha256}`), 'files_revision_mismatch')
    return result
  }
  async function readFiles(live) {
    active(); live.checkActive()
    const discovered = await request('identity', `${base()}/identity?${new URLSearchParams({ workspaceId: scope.workspaceId })}`)
    const parsed = runWorktreeIdentity.safeParse(discovered.identity)
    check(discovered.ok === true && parsed.success, 'files_identity_mismatch')
    identity = parsed.data
    check(identity.runId === record.runId && identity.workspaceId === scope.workspaceId && identity.ownerId === scope.ownerId
      && identity.deviceId === record.execution?.deviceId && identity.repositoryKey === REPOSITORY_KEY, 'files_identity_mismatch')
    evidence.identity = identityView(identity)
    live.checkActive(); active()
    const [treeBody, searchBody, policy] = await drainRequests([
      request('tree', fileURL({ kind: 'tree', path: '', limit: '200' })),
      request('search', fileURL({ kind: 'search', query: 'README.md', limit: '100' })),
      request('policy', '/api/agent-cli-policy', post({ operation: 'read', runId: record.runId })),
    ])
    check(policy.policy?.readOnly !== true && policy.policy?.permissions?.install_dependency === 'allow' && HASH.test(policy.revision ?? ''), 'native_shell_unavailable')
    evidence.policy = { revision: policy.revision, installDependency: 'allow', readOnly: false }
    const tree = validateRead(treeBody, 'tree'), search = validateRead(searchBody, 'search')
    for (const result of [tree, search]) {
      check(!result.truncated && result.entries.some(entry => entry.path === 'README.md' && entry.kind === 'file'), 'files_response_invalid')
      const entries = result.entries.map(({ path, name, kind }) => ({ path, name, kind, size: null }))
      check(result.revision.version === hash(JSON.stringify([result.revision.headSha, entries])), 'files_revision_mismatch')
      evidence[result.kind] = { revision: revisionView(result.revision), observedAt: result.observedAt, entryCount: result.entries.length }
    }
    check(tree.path === '' && tree.nextCursor === null, 'files_response_invalid')
    live.checkActive(); active()
    file = validateFile(await request('file', fileURL({ kind: 'file', path: 'README.md', startLine: '1', endLine: '20' })))
    check([tree, search].every(result => result.revision.headSha === file.revision.headSha && result.revision.baseSha === file.revision.baseSha), 'files_revision_mismatch')
    evidence.file = fileView(file)
    live.checkActive(); active()
    const selection = { kind: 'file', path: 'README.md', range: { startLine: 1, endLine: 20 } }
    const created = await request('mention_create', `${base()}/mentions`, post({ action: 'create', workspaceId: scope.workspaceId, repoId: identity.repoId, selection }))
    const mention = created.mention
    check(created.ok === true && UUID.test(mention?.id ?? '') && mention.runId === record.runId && mention.repoId === identity.repoId
      && same(mention.selection, selection) && mention.omitted === 0 && validTime(mention.expiresAt)
      && Date.parse(mention.expiresAt) > now() && Date.parse(mention.expiresAt) <= now() + 605000
      && same(mention.files, [{ path: 'README.md', range: { startLine: 1, endLine: file.endLine },
        expected: { headSha: file.revision.headSha, contentSha256: file.contentSha256 } }]), 'mention_invalid')
    mentionId = mention.id
    const contextVersion = hash(JSON.stringify([['README.md', file.contentSha256]]))
    check(same(mention.revision, { ...file.revision, version: contextVersion }), 'files_revision_mismatch')
    evidence.mention = { id: mentionId, expiresAt: mention.expiresAt, revision: revisionView(mention.revision) }
    live.checkActive(); active()
    const resolvedBody = await request('mention_resolve', `${base()}/mentions`, post({ action: 'resolve', workspaceId: scope.workspaceId, repoId: identity.repoId, ids: [mentionId] }))
    check(same(resolvedBody.ids, [mentionId]), 'mention_invalid')
    const { ids: _ids, ...contextBody } = resolvedBody
    const resolved = validateRead(contextBody, 'context')
    check(resolved.files.length === 1 && resolved.omitted === 0 && same(resolved.revision, mention.revision), 'mention_invalid')
    const reread = validateFile(resolved.files[0])
    check(same(fileView({ ...reread, observedAt: file.observedAt }), evidence.file), 'files_hash_mismatch')
    check(reread.observedAt === resolved.observedAt, 'files_observation_invalid')
    evidence.resolved = { revision: revisionView(resolved.revision), observedAt: resolved.observedAt, selectedSha256: hash(reread.content) }
    live.checkActive(); active()
    evidence.active = 'passed'
    // Source bytes never enter a record/report and are no longer needed.
    file = { ...file, content: null }
  }
  return {
    signal,
    instructions: `Review README.md in ${REPOSITORY} using the normal file reader. Run this exact read-only native shell command once, unchanged, in the current task worktree. Do not use MCP shell, fabricate its output, read credentials/environment, install anything, change files/branches, commit, push, open PRs, send messages, spawn agents, wait or retry. Then give a brief README review and reply STARTUP_OK_${record.sampleId}.\n\n${nativeProbeCommand(record.sampleId, record.harness)}`,
    async createIssue(input) {
      try {
        active()
        const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: this.instructions }] }] }
        if (scope.workspaceKind === 'personal') return await rpc('issue_create', 'issues.saveIssue', [{ ...input, content }])
        const teams = await rpc('teams', 'teams.listTeams', [])
        check(Array.isArray(teams), 'team_unavailable')
        const team = teams.find(team => UUID.test(team?.id ?? '') && team.workspaceId === scope.workspaceId)
        check(team, 'team_unavailable')
        evidence.teamId = team.id
        return await rpc('issue_create', 'issues.createIssueForTeam', [{ ...input, content, requestId: randomUUID(), teamId: team.id }])
      } catch (error) { return rememberFailure(error) }
    },
    async observe(detail, live) {
      try {
        active(); assertRunScope(detail, record)
        if (!attempted) {
          check(!TERMINAL.has(detail.thread.status), 'active_window_missed')
          const worktree = detail.chunks?.find(item => item.chunk?.type === 'data-run-stage' && item.chunk.data?.stage === 'worktree' && item.chunk.data.ok === true)
          // The daemon's worktree stage precedes the server's worktreePath
          // patch. The normal running push is the first authorized-ready
          // observation; preparing must not consume our single attempt.
          if (worktree && ['running', 'waiting_input', 'finishing'].includes(detail.thread.status)) {
            attempted = true
            check(validTime(worktree.at), 'files_observation_invalid')
            evidence.worktreeStoredAt = worktree.at; evidence.worktreeObservedAt = iso(now())
            await readFiles(live)
          }
        }
        if (!attempted) return false
        const receipt = nativeReceipt(detail, record, options)
        if (receipt) {
          native = receipt
          check(evidence.file && receipt.headSha === evidence.file.revision.headSha && receipt.contentSha256 === evidence.file.contentSha256
            && receipt.selectedSha256 === evidence.file.selectedSha256 && receipt.size === evidence.file.size
            && receipt.startLine === evidence.file.startLine && receipt.endLine === evidence.file.endLine && receipt.totalLines === evidence.file.totalLines,
          'native_file_mismatch')
          evidence.native = receipt
        }
        if (TERMINAL.has(detail.thread.status) && !native) check(false, 'native_tool_receipt_missing')
        return evidence.active === 'passed' && Boolean(native)
      } catch (error) { return rememberFailure(error) }
    },
    async afterRelease() {
      try {
        const cleanup = record.cleanup
        check(cleanup?.status === 'passed' && UUID.test(record.runId ?? '') && cleanup.machines?.some(item => item.runId === record.runId)
          && cleanup.machines.every(item => item.outcome === 'ended' && item.state === 'ended' && cleanup[`machineEnded_${item.runId}`] === true)
          && cleanup[`machineVerified_${record.runId}`] === true
          && cleanup.machineViews?.some(view => view.runId === record.runId && view.kind === 'cloud' && view.state === 'ended' && view.sandboxIdHash === null),
        'release_unconfirmed')
        evidence.released = true
        // Keep the real issue visible until typed refusals have been observed.
        const { issue } = await rpc('issue_read', 'issues.getIssue', [record.issueId])
        check(issue?.id === record.issueId && issue.title === record.title && Number.isSafeInteger(issue.revision), 'fixture_invalid')
        check(identity && mentionId && evidence.active === 'passed' && native, evidence.failure ?? 'native_tool_receipt_missing')
        evidence.denials = await drainRequests([
          request('released_identity', `${base()}/identity?${new URLSearchParams({ workspaceId: scope.workspaceId })}`, undefined, true),
          request('released_file', fileURL({ kind: 'file', path: 'README.md', startLine: '1', endLine: '20' }), undefined, true),
          request('released_mention', `${base()}/mentions`, post({ action: 'resolve', workspaceId: scope.workspaceId, repoId: identity.repoId, ids: [mentionId] }), true),
        ])
        try { await rpc('issue_delete', 'issue-operations.setIssueDeleted', [{ id: issue.id, revision: issue.revision }]) }
        catch (cause) { throw Object.assign(new Error('coding_workspace_fixture_delete_failed', { cause }), { code: 'fixture_delete_failed' }) }
        cleanup.taskDeleted = true; delete cleanup.taskRetained; delete cleanup.retainedFixture
        evidence.status = evidence.failure ? 'failed' : 'passed'
      } catch (error) { return rememberFailure(error) }
    },
  }
}

/** Explicit projection: arbitrary startup fields/chunks/client values never leave. */
function caseReport(sample) {
  const proof = sample.codingWorkspace
  const safeFailure = CODES.has(proof?.failure) ? proof.failure : sample.status === 'failed' ? 'execution_unproved' : 'acceptance_failed'
  const cleanup = sample.cleanup
  const passed = sample.status === 'execution_proved_awaiting_server_timing' && sample.replyVerifiedAfterTool === true
    && sample.execution?.credentialType === 'subscription' && (sample.execution?.sharedScope?.verified === true
      || sample.workspaceKind === 'personal' && sample.execution?.personalScope?.verified === true)
    && sample.execution?.harness === sample.harness && sample.execution?.model === MODELS[sample.harness]
    && proof?.status === 'passed' && cleanup?.status === 'passed' && cleanup.taskDeleted === true
  // proof is constructed only above from schema-checked responses. Project its
  // remaining objects through an explicit field vocabulary as a second fence.
  const allowed = new Set(['status', 'failure', 'requests', 'operation', 'startedAt', 'finishedAt', 'outcome', 'httpStatus', 'ms', 'teamId',
    'identity', 'version', 'runId', 'repoId', 'deviceId', 'workspaceId', 'ownerHash', 'repositoryKey', 'bindingId', 'policy', 'revision',
    'installDependency', 'readOnly', 'tree', 'search', 'source', 'headSha', 'baseSha', 'observedAt', 'entryCount', 'file', 'path', 'size',
    'contentSha256', 'selectedSha256', 'startLine', 'endLine', 'totalLines', 'truncated', 'mention', 'id', 'expiresAt', 'resolved', 'active',
    'worktreeStoredAt', 'worktreeObservedAt', 'native', 'caseId', 'harness', 'workerSha', 'workerSourceCommit', 'markerUid', 'markerMode',
    'markerWritable', 'sourceUid', 'sourceWritable', 'commandSha256', 'toolCallHash', 'inputAt', 'outputAt', 'released', 'denials', 'code'])
  const project = value => Array.isArray(value) ? value.map(project) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, project(item)])) : value
  const ids = [sample.runId, ...(cleanup?.retainedFixture?.runIds ?? [])].filter(id => UUID.test(id ?? ''))
  return { harness: Object.hasOwn(MODELS, sample.harness) ? sample.harness : 'unknown', model: MODELS[sample.harness] ?? null,
    ...(UUID.test(sample.issueId ?? '') ? { issueId: sample.issueId } : {}), ...(UUID.test(sample.runId ?? '') ? { runId: sample.runId } : {}),
    status: passed ? 'passed' : 'failed', ...(passed ? {} : { failure: safeFailure }),
    startupFailure: sample.failure ? startupFailure({ message: sample.failure.code }, sample.failure.phase) : null,
    proof: proof ? project(proof) : null,
    requestCount: proof?.requests?.filter(item => OPERATIONS.has(item.operation)).length ?? 0,
    requestMs: proof?.requests?.reduce((sum, item) => sum + (Number.isFinite(item.ms) ? item.ms : 0), 0) ?? 0,
    detailReads: Number.isSafeInteger(sample.detailReads) ? sample.detailReads : 0,
    cleanup: { status: cleanup?.status === 'passed' ? 'passed' : 'failed', machineReleased: proof?.released === true,
      issueDeleted: cleanup?.taskDeleted === true, errors: (cleanup?.errors ?? []).map(error => startupFailure({ message: error.code }, 'cleanup')),
      ...(!passed || cleanup?.retainedFixture ? { recovery: { issueId: UUID.test(sample.issueId ?? '') ? sample.issueId : null, runIds: [...new Set(ids)] } } : {}) } }
}

export async function runCodingWorkspaceAcceptance(options, { env = process.env, runStartup = runCloudStartup,
  fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now, signal } = {}) {
  check(options && SHA.test(options.sourceCommit ?? '') && SHA.test(options.workerSha ?? '') && SHA.test(options.workerSourceCommit ?? ''), 'options_invalid')
  check(options.workspaceKind === undefined || ['personal', 'team'].includes(options.workspaceKind), 'options_invalid')
  if (options.workspaceKind === 'personal') validatePersonalOptions({ ...options, mode: 'candidate',
    runs: options.harness && options.harness !== 'both' ? 1 : 2, expectedBuild: options.sourceCommit, revision: options.sourceCommit })
  const controller = new AbortController(), onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) controller.abort()
  process.once('SIGTERM', onAbort); process.once('SIGINT', onAbort)
  const startedAt = iso(now())
  const origin = options.workspaceKind === 'personal' ? options.origin ?? ORIGIN : ORIGIN
  const harnesses = options.workspaceKind === 'personal' && options.harness && options.harness !== 'both' ? [options.harness] : Object.keys(MODELS)
  let report
  try {
    check(!controller.signal.aborted, 'acceptance_aborted')
    report = await runStartup({ origin, runs: harnesses.length, harness: harnesses.length === 2 ? 'both' : harnesses[0], mode: 'candidate', strategy: 'derived',
      ...(options.workspaceKind === 'personal' ? { workspaceKind: 'personal', workspace: options.workspace,
        operation: options.operation ?? 'readiness', deviceId: options.deviceId, agentId: options.agentId } : {}),
      revision: options.sourceCommit, expectedBuild: options.sourceCommit, timeoutMs: 240000, maxStartupMs: 60000,
      runtimeEvidence: 'optional', officialTiming: 'disabled', titlePrefix: '测试 1721 Files' }, {
      env, fetchImpl, WebSocketImpl, now,
      caseProfileInstructions: 'Review README.md without changing files. Use the exact read-only native shell probe from this task once. Never inspect credentials or environment, install software, commit, push, open PRs, message others, spawn agents, wait or retry.',
      createCaseProbe: context => createWorkspaceProbe(options, { ...context, signal: controller.signal }),
    })
  } catch (error) {
    return { schemaVersion: 1, issue: 1721, origin, repository: REPOSITORY,
      sourceCommit: options.sourceCommit, workerSha: options.workerSha, workerSourceCommit: options.workerSourceCommit, startedAt, finishedAt: iso(now()),
      status: 'failed', failure: errorCode(error), startupFailure: startupFailure(error), samples: [], cleanup: { status: 'failed' } }
  } finally {
    process.removeListener('SIGTERM', onAbort); process.removeListener('SIGINT', onAbort)
    signal?.removeEventListener('abort', onAbort)
  }
  const samples = (report.samples ?? []).map(caseReport)
  const cleanup = { status: !report.cleanup?.errors?.length && report.cleanup?.workspaceRestored === true ? 'passed' : 'failed',
    workspaceRestored: report.cleanup?.workspaceRestored === true,
    errors: (report.cleanup?.errors ?? []).map(error => startupFailure({ message: error.code }, 'cleanup')) }
  if (options.workspaceKind === 'personal' && options.operation !== 'execute') return {
    schemaVersion: 1, issue: 1721, origin, repository: REPOSITORY, sourceCommit: options.sourceCommit,
    startedAt, finishedAt: iso(now()), status: report.status, executionVerified: false,
    ...(report.failure ? { failure: report.failure } : {}), readiness: report.readiness ?? null, samples: [], cleanup,
  }
  const passed = report.status === 'candidate_subscription_proved' && report.build === options.sourceCommit && report.revision === options.sourceCommit
    && samples.length === harnesses.length && same(samples.map(sample => sample.harness).sort(), [...harnesses].sort())
    && samples.every(sample => sample.status === 'passed') && cleanup.status === 'passed'
  return { schemaVersion: 1, issue: 1721, origin, repository: REPOSITORY,
    sourceCommit: options.sourceCommit, workerSha: options.workerSha, workerSourceCommit: options.workerSourceCommit,
    startedAt, finishedAt: iso(now()), status: passed ? options.workspaceKind === 'personal' ? 'partial' : 'passed' : 'failed',
    ...(options.workspaceKind === 'personal' ? { requiredHarnesses: Object.keys(MODELS),
      executionVerified: passed,
      verifiedHarnesses: samples.filter(sample => sample.status === 'passed').map(sample => sample.harness) } : {}),
    ...(passed ? {} : { failure: 'acceptance_failed' }), samples, cleanup }
}
