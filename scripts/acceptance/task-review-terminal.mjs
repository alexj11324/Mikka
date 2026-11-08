/** API-only #1723 acceptance for an explicitly supplied, already completed run.
 * No sign-in, identities, dispatch, provider SDK, VM teardown or automatic CLI.
 * The caller supplies the normal shared-smoke cookie client and owns cleanup.
 * Shell output/cookies stay in memory; returned evidence has closed fields only.
 */
import { randomUUID } from 'node:crypto'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const BUFFER_BYTES = 262144
const CODES = new Set(['scope', 'version', 'identity', 'run', 'response', 'stream', 'session', 'timeout', 'closed', 'command', 'cleanup'])
const API_CODES = new Set(['review_auth_required', 'review_not_found', 'not_owner_terminal', 'review_scope_denied',
  'review_machine_gone', 'review_binding_changed', 'review_checkout_unavailable', 'terminal_unsupported',
  'terminal_already_controlled', 'terminal_binding_changed', 'terminal_ended', 'terminal_unavailable'])
const fail = (code, cause) => { throw new Error(`terminal_acceptance_${code}`, cause ? { cause } : undefined) }
const requireValue = (condition, code) => { if (!condition) fail(code) }
const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })

export function terminalAcceptanceFailure(error) {
  const code = typeof error?.message === 'string' ? error.message.replace(/^terminal_acceptance_/, '') : ''
  return { code: CODES.has(code) ? `terminal_acceptance_${code}` : 'terminal_acceptance_failed' }
}

async function limitedJson(response) {
  const reader = response.body?.getReader()
  requireValue(reader, 'response')
  let text = ''
  try {
    const decoder = new TextDecoder()
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      text += decoder.decode(item.value, { stream: true })
      requireValue(text.length <= 8192, 'response')
    }
    try { return JSON.parse(text) } catch (cause) { fail('response', cause) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Only closed error codes are returned, never arbitrary response diagnostics. */
export async function verifyTerminalRefusal({ client, taskId, status, codes, workspaceId, method = 'GET' }) {
  requireValue(UUID.test(taskId ?? '') && [403, 404, 409, 423].includes(status)
    && Array.isArray(codes) && codes.length > 0 && codes.every(code => API_CODES.has(code))
    && (!workspaceId || UUID.test(workspaceId)) && ['GET', 'POST'].includes(method), 'scope')
  const path = `/api/tasks/${taskId}/review/terminal${method === 'POST' ? '/input' : ''}`
  const init = method === 'POST' ? post({ data: '' }) : { headers: { accept: 'text/event-stream' } }
  if (workspaceId) init.headers['x-mikka-workspace-id'] = workspaceId
  const response = await client.request(path, init)
  if (response.status !== status) { await response.body?.cancel(); fail('response') }
  const body = await limitedJson(response)
  requireValue(codes.includes(body.error), 'response')
  return { method, path, status, error: body.error }
}

/** Live frames and deadline timers only; no status polling or output logging. */
class TerminalProbe {
  constructor(response, abort, timeoutMs) {
    requireValue(response.status === 200 && response.headers.get('content-type')?.includes('text/event-stream')
      && UUID.test(response.headers.get('x-terminal-session-id') ?? '') && response.body, 'stream')
    this.id = response.headers.get('x-terminal-session-id')
    this.abort = abort; this.timeoutMs = timeoutMs; this.reader = response.body.getReader()
    this.text = ''; this.pending = ''; this.session = null; this.ended = null
    this.initialOutput = false; this.closed = false; this.failure = null; this.waiters = new Set()
    this.done = this.consume()
  }
  async consume() {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const item = await this.reader.read()
        if (item.done) break
        this.pending += decoder.decode(item.value, { stream: true }).replaceAll('\r\n', '\n')
        requireValue(this.pending.length <= BUFFER_BYTES, 'stream')
        for (let offset; (offset = this.pending.indexOf('\n\n')) >= 0;) {
          const frame = this.pending.slice(0, offset); this.pending = this.pending.slice(offset + 2)
          const kind = frame.split('\n').find(line => line.startsWith('event: '))?.slice(7)
          const lines = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
          if (!lines.length) continue
          let value
          try { value = JSON.parse(lines.join('\n')) } catch (cause) { fail('stream', cause) }
          if (kind === 'output') {
            requireValue(typeof value.text === 'string', 'stream')
            if (!this.initialOutput) { requireValue(value.text === '', 'stream'); this.initialOutput = true }
            this.text = (this.text + value.text).slice(-BUFFER_BYTES)
          } else if (kind === 'session') this.session = value
          else if (kind === 'ended') {
            requireValue(value.exitCode === null || Number.isInteger(value.exitCode), 'stream')
            this.ended = value
          }
          this.notify()
        }
      }
    } catch (cause) { if (!this.abort.signal.aborted) this.failure = new Error('terminal_acceptance_stream', { cause }) }
    finally { this.closed = true; this.reader.releaseLock(); this.notify() }
  }
  notify() { for (const next of this.waiters) next() }
  waitFor(predicate) {
    return new Promise((resolve, reject) => {
      let timer
      const finish = error => { clearTimeout(timer); this.waiters.delete(check); if (error) reject(error); else resolve() }
      const check = () => {
        if (this.failure) finish(this.failure)
        else if (predicate()) finish()
        else if (this.closed) finish(new Error('terminal_acceptance_closed'))
      }
      timer = setTimeout(() => finish(new Error('terminal_acceptance_timeout')), this.timeoutMs)
      this.waiters.add(check); check()
    })
  }
  line(value) { return this.waitFor(() => this.text.split(/\r?\n/).includes(value)) }
  async cancel() { this.abort.abort(); await this.reader.cancel().catch(() => {}); await this.done }
}

/** Complete positive PTY proof against this exact normal-session task/run.
 * Call before the existing Native driver's cleanupCase; it otherwise ends the
 * VM and deletes the issue. Optional peer/other-workspace checks do not create
 * identities or change their selected workspace. Reclaimed/local checks are
 * separate verifyTerminalRefusal calls with explicitly supplied fixtures.
 */
export async function verifyExistingTaskTerminal({ client, taskId, runId, ownerId, workspaceId, expectedBuild,
  peerClient, otherWorkspaceId, timeoutMs = 20000 }) {
  const report = { version: 1, issue: 1723, scope: 'existing_cloud_terminal', status: 'running', checks: {}, cleanup: { status: 'not_opened' } }
  let stream, opened = false
  let phase = 'scope'
  const controls = []
  const path = UUID.test(taskId ?? '') ? `/api/tasks/${taskId}/review/terminal` : null
  const open = async () => {
    const abort = new AbortController()
    try {
      const response = await client.request(path, { headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(240000)]) })
      opened = response.status === 200 || opened
      if (response.status !== 200) { await response.body?.cancel(); fail('stream') }
      return new TerminalProbe(response, abort, timeoutMs)
    } catch (error) { abort.abort(); throw error }
  }
  const input = async (data, requestId = randomUUID()) => {
    const response = await client.request(`${path}/input`, post({ data, requestId }))
    await response.body?.cancel()
    requireValue(response.status === 204 && response.headers.get('x-terminal-request-id') === requestId, 'command')
    controls.push({ operation: 'input', status: 204, requestId })
  }
  const pin = async () => requireValue((await client.json('/api/version')).build === expectedBuild, 'version')
  const command = async (text, marker) => { await input(`${text}; printf '\\n%s\\n' '${marker}'\n`); await stream.line(marker) }
  try {
    requireValue(path && UUID.test(runId ?? '') && UUID.test(workspaceId ?? '') && typeof ownerId === 'string' && ownerId.length > 0
      && SHA.test(expectedBuild ?? '') && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000
      && (!otherWorkspaceId || UUID.test(otherWorkspaceId) && otherWorkspaceId !== workspaceId), 'scope')
    Object.assign(report, { taskId, runId, build: expectedBuild })
    phase = 'version'; await pin()
    phase = 'identity'
    const identity = await client.json('/api/auth/get-session'), workspace = await client.json('/api/workspace')
    requireValue(identity.user?.id === ownerId && isSmokeAccountEmail(identity.user.email)
      && workspace.currentUserId === ownerId && workspace.workspace?.id === workspaceId, 'identity')
    phase = 'run'
    const { run } = await client.json(`/api/runs/${runId}/evidence`)
    requireValue(run?.id === runId && run.issueId === taskId && ['succeeded', 'failed'].includes(run.status)
      && run.executionIdentity?.workspaceId === workspaceId && run.executionIdentity.requester === ownerId
      && run.executionIdentity.executionPrincipal === ownerId && run.executionIdentity.billingAccount?.runtime?.kind === 'e2b', 'run')
    report.checks.completedRun = true
    phase = 'stream'; stream = await open()
    await stream.waitFor(() => stream.session !== null && stream.initialOutput)
    const session = stream.session
    requireValue(session.terminalSessionId === stream.id && session.runId === runId && session.ownerId === ownerId
      && Number.isSafeInteger(session.expiresAt) && session.expiresAt > Date.now() && session.expiresAt <= Date.now() + 300000, 'session')
    report.checks.readySse = { method: 'GET', path, status: 200, firstOutputEmpty: true }
    phase = 'commands'
    const prefix = `MIKKA_PTY_${randomUUID().replaceAll('-', '')}`
    await command("stty -echo; PS1=''; MIKKA_ACCEPTANCE_COUNT=0", `${prefix}_READY`)
    const repository = `${prefix}_REPOSITORY`
    await input(`pwd -P; git -c color.status=false status --short && test "$(pwd -P)" = "$(git rev-parse --show-toplevel)" && bash --noprofile --norc -c 'test "$(git rev-parse --is-inside-work-tree)" = true' && printf '\\n%s\\n' '${repository}'\n`)
    await stream.line(repository); report.checks.runWorktreeAndShellTest = true
    const resize = await client.request(`${path}/resize`, post({ cols: 112, rows: 37 }))
    await resize.body?.cancel(); requireValue(resize.status === 204, 'command')
    await input(`test "$(stty size)" = '37 112' && printf '\\n%s\\n' '${prefix}_RESIZED'\n`)
    await stream.line(`${prefix}_RESIZED`); report.checks.resize = { status: 204, cols: 112, rows: 37 }
    await input(`printf '\\n%s\\n' '${prefix}_SLEEP'; sleep 30\n`); await stream.line(`${prefix}_SLEEP`)
    const interruptedAt = Date.now(); await input('\u0003')
    await command(':', `${prefix}_INTERRUPTED`)
    requireValue(Date.now() - interruptedAt < 15000, 'command')
    report.checks.ctrlC = { status: 204, interruptedWithinMs: Date.now() - interruptedAt }
    const requestId = randomUUID(), once = `MIKKA_ACCEPTANCE_COUNT=$((MIKKA_ACCEPTANCE_COUNT + 1))\n`
    await input(once, requestId); await input(once, requestId)
    await input(`test "$MIKKA_ACCEPTANCE_COUNT" = 1 && printf '\\n%s\\n' '${prefix}_ONCE'\n`)
    await stream.line(`${prefix}_ONCE`); report.checks.inputAtMostOnce = { requestId, attempts: 2, executions: 1 }
    phase = 'reconnect'; await stream.cancel(); stream = await open()
    await stream.waitFor(() => stream.session !== null && stream.initialOutput)
    requireValue(stream.id === session.terminalSessionId && stream.session.expiresAt === session.expiresAt
      && stream.session.runId === runId && stream.session.ownerId === ownerId, 'session')
    await stream.line(`${prefix}_ONCE`)
    await input(`test "$MIKKA_ACCEPTANCE_COUNT" = 1 && printf '\\n%s\\n' '${prefix}_RESUMED'\n`)
    await stream.line(`${prefix}_RESUMED`)
    report.checks.reconnect = { sameSession: true, sameAbsoluteExpiry: true, scrollback: true, shellStateRetained: true }
    phase = 'authority'
    if (otherWorkspaceId) report.checks.otherWorkspace = await verifyTerminalRefusal({ client, taskId, workspaceId: otherWorkspaceId, status: 403, codes: ['review_scope_denied'] })
    if (peerClient) {
      const peer = await peerClient.json('/api/auth/get-session')
      requireValue(typeof peer.user?.id === 'string' && peer.user.id !== ownerId, 'identity')
      report.checks.nonOwner = []
      for (const method of ['GET', 'POST']) report.checks.nonOwner.push(await verifyTerminalRefusal({ client: peerClient, taskId, status: 403, codes: ['not_owner_terminal'], method }))
    }
    phase = 'exit'; await input('exit 7\n'); await stream.waitFor(() => stream.ended !== null)
    requireValue(stream.ended.exitCode === 7, 'command'); await stream.waitFor(() => stream.closed)
    report.checks.exit = { event: 'ended', exitCode: 7, eof: true }
    phase = 'version'; await pin()
    report.status = 'passed_for_requested_scope'
  } catch (error) { report.status = 'failed'; report.failure = { phase, ...terminalAcceptanceFailure(error) } }
  finally {
    if (stream) await stream.cancel().catch(() => {})
    if (opened) {
      try {
        const response = await client.request(path, { method: 'DELETE' })
        await response.body?.cancel(); requireValue(response.status === 204, 'cleanup')
        report.cleanup = { status: 'closed', method: 'DELETE', path, httpStatus: 204 }
      } catch (error) { report.cleanup = { status: 'unconfirmed', ...terminalAcceptanceFailure(error) }; report.status = 'failed' }
    }
  }
  report.controls = controls
  report.remaining = [!peerClient && 'non_owner_session', !otherWorkspaceId && 'different_workspace', 'reclaimed_after_owned_fixture_end', 'local_machine_target'].filter(Boolean)
  return report
}
