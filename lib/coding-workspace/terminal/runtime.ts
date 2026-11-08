import 'server-only'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Sandbox, SandboxNotFoundError } from 'e2b'
import { TerminalError } from '@mikka/protocol/coding-terminal'
import { e2bApiKey, withE2BErrors } from '@/lib/secrets/e2b-runtime'
import type { TaskReviewAuthority } from '../review-authority'
import { terminalKey, signTerminalTicket, terminalResponseError, type TerminalPrepared, type TerminalTarget } from './wire'

const PORT = 6084
const ROOT = '/run/mikka-terminal'
const INSTALL = '/opt/mikka/terminal'
const INGRESS = '/opt/mikka/runtime/ingress-v1/guard.py'
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function options(ownerId: string, signal?: AbortSignal) {
  return { apiKey: await e2bApiKey(ownerId, 'Task terminal is not configured'),
    proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy, requestTimeoutMs: 15_000, retries: 0, signal }
}

function cloud(scope: TaskReviewAuthority): asserts scope is TaskReviewAuthority & { sandboxId: string } {
  if (scope.machineKind !== 'cloud') throw new TerminalError('terminal_unsupported', { detail: 'local_device' })
  if (!scope.sandboxId) throw new TerminalError('terminal_binding_changed')
  // A DB pause flag is never a native-exit receipt. The gateway additionally
  // checks the exact idle daemon receipt while holding its execution flock.
  if (!scope.nativeExitedProof) throw new TerminalError('terminal_already_controlled')
}

/** getInfo is read-only. Input and revocation never call Sandbox.connect,
 * which would silently resume a parked VM. */
async function endpoint(target: TerminalTarget, signal?: AbortSignal) {
  const config = await options(target.ownerId, signal)
  const info = await withE2BErrors(target.ownerId, false, () => Sandbox.getInfo(target.sandboxId, config))
  if (info.state !== 'running') throw new TerminalError('terminal_binding_changed')
  // Use the SDK's routing primitive, without connecting/resuming its machine.
  const sandbox = new Sandbox({ ...config, sandboxId: target.sandboxId, sandboxDomain: info.sandboxDomain, envdVersion: info.envdVersion })
  const host = sandbox.getHost(PORT)
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:e2b\.app|e2b\.dev)$/i.test(host)) throw new TerminalError('terminal_unavailable', { detail: 'configuration' })
  return { origin: `https://${host}`, config }
}

async function health(origin: string, key: Buffer, signal?: AbortSignal): Promise<{ boot: string; version: string } | null> {
  try {
    const challenge = randomUUID()
    const response = await fetch(`${origin}/health?challenge=${challenge}`, { cache: 'no-store', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) })
    if (!response.ok) { await response.body?.cancel(); return null }
    if (Number(response.headers.get('content-length') ?? 0) > 1024) { await response.body?.cancel(); return null }
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 1024) return null
        chunks.push(value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value?.boot !== 'string' || !/^[a-f0-9-]{36}$/.test(value.boot) || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version) ||
      typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof)) return null
    const expected = createHmac('sha256', key).update(`health:v1:${challenge}:${value.boot}:${value.version}`).digest()
    return timingSafeEqual(Buffer.from(value.proof, 'hex'), expected) ? { boot: value.boot, version: value.version } : null
  } catch { signal?.throwIfAborted(); return null }
}

async function verifyRuntime(sandbox: Sandbox, signal?: AbortSignal) {
  // Worker refresh may add the execution fence to an old VM without the
  // pre-worker ingress guard. Verify both in one read-only opening preflight;
  // never install or repair network rules after user processes have started.
  const checked = await sandbox.commands.run(`if test -f /run/mikka-review-control/version && test ! -L /run/mikka-review-control/version && test "$(cat /run/mikka-review-control/version)" = 1 && test -f ${INGRESS} && test ! -L ${INGRESS}; then python3 ${INGRESS} verify || :; fi`,
    { user: 'root', timeoutMs: 30_000, signal })
  let value: Record<string, unknown>
  try {
    if (checked.exitCode !== 0 || checked.stdout.length > 4096) throw new TerminalError('terminal_unsupported', { detail: 'runtime_version' })
    value = JSON.parse(checked.stdout) as Record<string, unknown>
  } catch (cause) {
    if (cause instanceof TerminalError) throw cause
    throw new TerminalError('terminal_unsupported', { detail: 'runtime_version', cause })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true || value.version !== 1
    || value.preparedBeforeWorker !== true || typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || typeof value.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.bootId)
    || !Number.isSafeInteger(value.installedTicks) || Number(value.installedTicks) < 0
    || !['[49983]', '[49983,50005]'].includes(JSON.stringify(value.providerPorts))
    || JSON.stringify(value.rulesVerified) !== '{"ipv4":true,"ipv6":true}')
    throw new TerminalError('terminal_unsupported', { detail: 'runtime_version' })
}

/** Prepare before the final database fence. No shell or task is started. */
export async function prepareTerminal(scope: TaskReviewAuthority, signal?: AbortSignal): Promise<TerminalPrepared> {
  cloud(scope)
  try {
    const target = { runId: scope.runId, ownerId: scope.ownerId, workspaceId: scope.workspaceId, sandboxId: scope.sandboxId }
    const { origin, config } = await endpoint(target, signal)
    const source = await readFile(join(process.cwd(), 'scripts/e2b/terminal-gateway.py'), 'utf8')
    const version = createHash('sha256').update(source).digest('hex')
    const key = terminalKey(target, process.env.BETTER_AUTH_SECRET)
    let current = await health(origin, key, signal)
    if (current && current.version !== version) throw new TerminalError('terminal_unsupported', { detail: 'runtime_version' })
    // Only opening/reconnecting performs this root check. Input/resize/close
    // keep the existing data plane and never issue a per-command SDK RPC.
    const sandbox = await withE2BErrors(scope.ownerId, false, () => Sandbox.connect(scope.sandboxId, { ...config, timeoutMs: 5 * 60_000 }))
    await verifyRuntime(sandbox, signal)
    if (!current) {
      // resumeReviewMachine has already acquired the dedicated review lease.
      // The same running sandbox is the only target; never create a VM here.
      await sandbox.commands.run(`install -d -m 700 -o root -g root ${ROOT} && install -d -m 755 -o root -g root ${INSTALL}`, { user: 'root', timeoutMs: 5_000, signal })
      const path = `${INSTALL}/gateway-${version}.py`
      await sandbox.files.write([{ path, data: source }, { path: `${ROOT}/key`, data: Uint8Array.from(key).buffer }], { user: 'root', signal })
      await sandbox.commands.run(`chmod 600 ${ROOT}/key && chmod 444 ${path}`, { user: 'root', timeoutMs: 5_000, signal })
      // A single readiness pipe, with a deadline; no HTTP or database poll.
      // The detached process writes one fixed readiness line and no content.
      const start = `import os,select,subprocess,sys\np=subprocess.Popen([sys.executable,'-I','-u',${JSON.stringify(path)}],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)\nready=select.select([p.stdout],[],[],10)[0]\nline=p.stdout.readline() if ready else b''\np.stdout.close()\nif line!=b'terminal-ready\\n':\n if p.poll() is None:p.terminate()\n raise SystemExit(1)\n`
      // A concurrent authorized preparation may own the listener already.
      await sandbox.commands.run(`python3 -I -c ${quote(start)}`, { user: 'root', timeoutMs: 15_000, signal }).catch(() => undefined)
      current = await health(origin, key, signal)
    }
    if (!current || current.version !== version) throw new TerminalError('terminal_unsupported', { detail: 'runtime_version' })
    return { origin, boot: current.boot, key, bindingId: scope.bindingId }
  } catch (cause) {
    if (cause instanceof TerminalError) throw cause
    if (cause instanceof SandboxNotFoundError) throw new TerminalError('terminal_binding_changed', { cause })
    throw new TerminalError('terminal_unavailable', { detail: 'installation', cause })
  }
}

/** Existing data-plane only, for input/resize/close. Never install or reopen. */
export async function existingTerminal(scope: TaskReviewAuthority, signal?: AbortSignal): Promise<TerminalPrepared> {
  cloud(scope)
  try {
    const target = { runId: scope.runId, ownerId: scope.ownerId, workspaceId: scope.workspaceId, sandboxId: scope.sandboxId }
    const { origin } = await endpoint(target, signal)
    const key = terminalKey(target, process.env.BETTER_AUTH_SECRET)
    const current = await health(origin, key, signal)
    if (!current) throw new TerminalError('terminal_ended')
    return { origin, boot: current.boot, key, bindingId: scope.bindingId }
  } catch (cause) {
    if (cause instanceof TerminalError) throw cause
    if (cause instanceof SandboxNotFoundError) throw new TerminalError('terminal_binding_changed', { cause })
    throw new TerminalError('terminal_unavailable', { detail: 'runtime', cause })
  }
}

export async function terminalRequest(prepared: TerminalPrepared, operation: 'stream' | 'input' | 'resize' | 'close', ticket: string, body = '', signal?: AbortSignal) {
  try {
    const response = await fetch(`${prepared.origin}/${operation}`, { method: operation === 'stream' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${ticket}`, ...(operation === 'stream' ? { accept: 'text/event-stream' } : { 'content-type': 'application/json' }) },
      ...(operation === 'stream' ? {} : { body }), cache: 'no-store', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(operation === 'stream' ? 300_000 : 15_000)]) : AbortSignal.timeout(operation === 'stream' ? 300_000 : 15_000),
    })
    if (!response.ok) throw await terminalResponseError(response)
    if (operation === 'stream' && (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')))
      throw new TerminalError('terminal_unavailable', { detail: 'protocol' })
    return response
  } catch (cause) {
    if (cause instanceof TerminalError) throw cause
    throw new TerminalError('terminal_unavailable', { detail: 'runtime', cause })
  }
}

/** Called by the durable shared revocation adapter. A missing/parked VM is
 * left pending for the existing lifecycle; revocation never wakes execution. */
export async function revokeRunTerminal(target: TerminalTarget, control: { leaseIds: string[]; expiresAt?: string } = { leaseIds: [] }): Promise<void> {
  const config = await options(target.ownerId)
  const info = await withE2BErrors(target.ownerId, false, () => Sandbox.getInfo(target.sandboxId, config)).catch(cause => {
    if (cause instanceof SandboxNotFoundError) return null
    throw new TerminalError('terminal_unavailable', { detail: 'runtime', cause })
  })
  if (!info) return // Provider confirms this exact sandbox was destroyed.
  if (info.state === 'paused') {
    const expiry = Date.parse(control.expiresAt ?? '')
    // Absolute lease expiry is enforced at every gateway input/output boundary
    // even when VM suspension prevented its deadline callbacks from running.
    if (Number.isFinite(expiry) && expiry <= Date.now()) return
    throw new TerminalError('terminal_binding_changed')
  }
  const { origin } = await endpoint(target)
  const key = terminalKey(target, process.env.BETTER_AUTH_SECRET)
  const current = await health(origin, key)
  if (!current) throw new TerminalError('terminal_unavailable', { detail: 'runtime' })
  const body = JSON.stringify({ leaseIds: control.leaseIds })
  const ticket = signTerminalTicket(key, { version: 1, operation: 'revoke', boot: current.boot, nonce: randomUUID(),
    expiresAt: Date.now() + 30_000, bodyDigest: createHash('sha256').update(body).digest('hex'),
    runId: target.runId, ownerId: target.ownerId, workspaceId: target.workspaceId })
  const response = await fetch(`${origin}/revoke`, { method: 'POST', headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw await terminalResponseError(response)
  await response.body?.cancel()
}
