import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sandbox } from 'e2b'
import { CodedError, type CodedErrorOptions } from '@mikka/protocol/coded-error'
import { connectComputer, computerGone, computerState } from '@/lib/computer/e2b-provider'
import { authTrustedOrigins } from '@/lib/auth-config'
import { cloudflareReview, reviewReply, type CloudflareReview } from '../cloudflare-review'
import type { ReviewSessionLease } from '../review-sessions'
import type { TaskReviewAuthority } from '../review-authority'

const ROOT = '/run/mikka-preview'
const SCRIPT = '/opt/mikka/preview/preview-gateway.py'
const INGRESS = '/opt/mikka/runtime/ingress-v1/guard.py'
export const PREVIEW_LIFETIME_MS = 5 * 60_000
export type PreviewFailureDetail = 'configuration' | 'runtime' | 'protocol' | 'scope_changed' | 'limit'
export class PreviewRuntimeError extends CodedError<'review_preview_unavailable'> {
  readonly status: number
  constructor(detail: PreviewFailureDetail, status = 503, options: CodedErrorOptions = {}) {
    super('review_preview_unavailable', { ...options, detail })
    this.status = status
  }
}

type Binding = {
  taskId: string; runId: string; ownerId: string; workspaceId: string; deviceId: string
  repoId: string; sandboxId: string; epoch: number; worktreePath: string; expiresAt: number
}
export type PreviewUnavailable = { running: false; state: 'unavailable'; code: 'no_loopback_server'; observedAt: number }
export type PreparedPreview = {
  running:true; binding:Binding; port:number; expiresAt:string
} & ({sandbox:Sandbox;gatewayPort:number;cloudflare?:undefined} | {cloudflare:CloudflareReview;origin:string})
export type PreviewRevokeTarget = { runId: string; ownerId: string; workspaceId: string; sandboxId: string }
type Json = Record<string, unknown>
type Connector = typeof connectComputer
type StateReader = typeof computerState

export function previewParentOrigin(request: Request): string {
  const allowed = authTrustedOrigins(process.env).filter(origin => /^https?:\/\//.test(origin))
  const application = new URL(request.url).origin
  const parent = request.headers.get('origin') ?? application
  if (!allowed.includes(application) || !allowed.includes(parent)) throw new PreviewRuntimeError('configuration', 403)
  return parent
}

function readReply(stdout: string): Json {
  try {
    const result: unknown = JSON.parse(stdout)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new PreviewRuntimeError('protocol')
    const reply = result as Json
    if (typeof reply.error === 'string') {
      const status = typeof reply.status === 'number' && [400, 403, 404, 409, 429, 503].includes(reply.status) ? reply.status : 503
      throw new PreviewRuntimeError(reply.error.endsWith('_limit') ? 'limit'
        : ['invalid_scope', 'scope_changed', 'authorization_revoked', 'authorization_expired'].includes(reply.error) ? 'scope_changed'
          : ['runtime_version_mismatch', 'firewall_unsupported', 'firewall_unavailable'].includes(reply.error) ? 'configuration' : 'runtime', status)
    }
    return reply
  } catch (cause) {
    if (cause instanceof PreviewRuntimeError) throw cause
    throw new PreviewRuntimeError('protocol', 503, { cause })
  }
}

async function verifyIngress(sandbox: Sandbox): Promise<void> {
  // Old VMs must stay unsupported. This command cannot install or repair a
  // rule after a task has already started listening on a public dev port.
  const checked = await sandbox.commands.run(`if test -f ${INGRESS}; then python3 ${INGRESS} verify || :; else printf '{"ok":false}'; fi`,
    { user: 'root', timeoutMs: 30_000 })
  let value: Json
  try {
    if (checked.stdout.length > 4096) throw new PreviewRuntimeError('configuration', 404)
    value = JSON.parse(checked.stdout) as Json
  } catch (cause) {
    if (cause instanceof PreviewRuntimeError) throw cause
    throw new PreviewRuntimeError('configuration', 404, { cause })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true || value.version !== 1
    || value.preparedBeforeWorker !== true || typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || typeof value.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.bootId)
    || !Number.isSafeInteger(value.installedTicks) || Number(value.installedTicks) < 0
    || !['[49983]', '[49983,50005]'].includes(JSON.stringify(value.providerPorts))
    || JSON.stringify(value.rulesVerified) !== '{"ipv4":true,"ipv6":true}')
    throw new PreviewRuntimeError('configuration', 404)
}

async function install(sandbox: Sandbox): Promise<void> {
  const source = await readFile(join(process.cwd(), 'scripts/e2b/preview-gateway.py'), 'utf8')
  const firewall = await readFile(join(process.cwd(), 'scripts/e2b/preview_firewall.py'), 'utf8')
  const expected = createHash('sha256').update(source).update(firewall).digest('hex')
  await sandbox.commands.run(`install -d -m 700 ${ROOT} /opt/mikka/preview`, { user: 'root', timeoutMs: 10_000 })
  await sandbox.files.write(SCRIPT, source, { user: 'root' })
  await sandbox.files.write('/opt/mikka/preview/preview_firewall.py', firewall, { user: 'root' })
  const installed = await sandbox.commands.run(`python3 ${SCRIPT} ensure`, { user: 'root', timeoutMs: 15_000 })
  if (readReply(installed.stdout).version !== expected) throw new PreviewRuntimeError('configuration')
}

async function control(sandbox: Sandbox, message: Json): Promise<Json> {
  const path = `${ROOT}/request-${randomUUID()}.json`
  // No capability or identity appears in command text, environment, or logs.
  // The root-only directory protects the file before chmod as well.
  await sandbox.files.write(path, JSON.stringify(message), { user: 'root' })
  try {
    const result = await sandbox.commands.run(`chmod 600 ${path} && python3 ${SCRIPT} control ${path}`, { user: 'root', timeoutMs: 30_000 })
    return readReply(result.stdout)
  } finally {
    await sandbox.commands.run(`rm -f ${path}`, { user: 'root', timeoutMs: 5_000 })
  }
}

export async function prepareRunPreview(authority: TaskReviewAuthority, options: { expiresAt?: string; port?: number; lease?: ReviewSessionLease } = {}, connect: Connector = connectComputer, state: StateReader = computerState): Promise<PreparedPreview | PreviewUnavailable> {
  if (authority.machineKind !== 'cloud' || !authority.sandboxId || authority.machineEpoch === null)
    throw new PreviewRuntimeError('configuration', 404)
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535))
    throw new PreviewRuntimeError('configuration', 400)
  const expires = Math.min(Date.now() + PREVIEW_LIFETIME_MS,
    options.expiresAt ? Date.parse(options.expiresAt) : Infinity,
    authority.credentialExpiresAt ? Date.parse(authority.credentialExpiresAt) : Infinity)
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new PreviewRuntimeError('scope_changed', 403)
  const binding: Binding = {
    taskId: authority.taskId, runId: authority.runId, ownerId: authority.ownerId, workspaceId: authority.workspaceId,
    deviceId: authority.deviceId, repoId: authority.repoId, sandboxId: authority.sandboxId,
    epoch: authority.machineEpoch, worktreePath: authority.worktreePath, expiresAt: expires / 1000,
  }
  try {
    if (authority.sponsoredPlacement) {
      const review = cloudflareReview(authority,options.lease,'preview')
      const reply = await reviewReply(review,'preview-prepare',{port:options.port})
      if (reply.running === false && reply.code === 'no_loopback_server')
        return {running:false,state:'unavailable',code:'no_loopback_server',observedAt:Date.now()}
      if (reply.running !== true || typeof reply.port !== 'number' || !Number.isInteger(reply.port) ||
          reply.port < 1024 || reply.port > 65535 || typeof reply.origin !== 'string' ||
          typeof reply.expiresAt !== 'number' || reply.expiresAt > binding.expiresAt + 1 || reply.expiresAt <= Date.now()/1000)
        throw new PreviewRuntimeError('protocol')
      const origin = new URL(reply.origin)
      if (origin.origin !== reply.origin || origin.protocol !== 'https:') throw new PreviewRuntimeError('protocol')
      return {running:true,cloudflare:review,origin:origin.origin,port:reply.port,binding,expiresAt:new Date(reply.expiresAt*1000).toISOString()}
    }
    // E2B connect() can resume a VM. Only the explicit authorized resume path
    // may do that; discovery never wakes a parked machine as a side effect.
    if (await state(authority.workspaceId, authority.sandboxId) !== 'running') throw new PreviewRuntimeError('scope_changed', 409)
    const sandbox = await connect(authority.workspaceId, authority.sandboxId, AbortSignal.timeout(45_000))
    if (sandbox.sandboxId !== authority.sandboxId) throw new PreviewRuntimeError('scope_changed', 409)
    await verifyIngress(sandbox)
    await install(sandbox)
    const reply = await control(sandbox, { operation: 'prepare', binding, ...(options.port === undefined ? {} : { port: options.port }) })
    if (reply.running === false && reply.code === 'no_loopback_server')
      return { running: false, state: 'unavailable', code: 'no_loopback_server', observedAt: Date.now() }
    if (reply.running !== true || !Number.isInteger(reply.gatewayPort) || Number(reply.gatewayPort) < 1024 || Number(reply.gatewayPort) > 65535
      || !Number.isInteger(reply.port) || Number(reply.port) < 1024 || Number(reply.port) > 65535
      || typeof reply.expiresAt !== 'number' || reply.expiresAt > binding.expiresAt + 1 || reply.expiresAt <= Date.now() / 1000)
      throw new PreviewRuntimeError('protocol')
    binding.expiresAt = reply.expiresAt
    return { running: true, sandbox, binding, gatewayPort: Number(reply.gatewayPort), port: Number(reply.port), expiresAt: new Date(reply.expiresAt * 1000).toISOString() }
  } catch (cause) {
    if (cause instanceof PreviewRuntimeError) throw cause
    throw new PreviewRuntimeError(computerGone(cause) ? 'scope_changed' : 'runtime', computerGone(cause) ? 409 : 503, { cause })
  }
}

/** Called only after the expected binding has been reauthorized and a durable
 * revocation lease committed. Only this step releases a one-use browser URL. */
export async function issueRunPreview(prepared: PreparedPreview, parentOrigin: string, lease: { id: string; expiresAt: string }) {
  const expires = Date.parse(lease.expiresAt)
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.parse(prepared.expiresAt)) throw new PreviewRuntimeError('scope_changed', 403)
  const host = prepared.cloudflare ? new URL(prepared.origin).host : prepared.sandbox.getHost(prepared.gatewayPort)
  const origin = new URL(`https://${host}`)
  const parent = new URL(parentOrigin)
  if (origin.host !== host || origin.username || origin.password || origin.pathname !== '/' || parent.origin === origin.origin
    || !authTrustedOrigins(process.env).includes(parentOrigin) || parent.origin !== parentOrigin)
    throw new PreviewRuntimeError('configuration')
  if (prepared.cloudflare && prepared.cloudflare.scope.leaseId !== lease.id) throw new PreviewRuntimeError('scope_changed',403)
  const reply = prepared.cloudflare ? await reviewReply(prepared.cloudflare,'preview-issue',{parentOrigin,expiresAt:expires})
    : await control(prepared.sandbox, { operation: 'issue', binding: { ...prepared.binding, expiresAt: expires / 1000 },
    gatewayPort: prepared.gatewayPort, origin: origin.origin, parentOrigin: parent.origin, leaseId: lease.id })
  if (prepared.cloudflare && reply.origin !== prepared.origin) throw new PreviewRuntimeError('protocol')
  if (typeof reply.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(reply.ticket) || typeof reply.expiresAt !== 'number' || reply.expiresAt * 1000 > expires)
    throw new PreviewRuntimeError('protocol')
  const url = new URL('/__mikka/preview/open', origin)
  url.searchParams.set('ticket', reply.ticket)
  return { running: true as const, url: url.toString(), state: 'available' as const, observedAt: Date.now(),
    expiresAt: new Date(reply.expiresAt * 1000).toISOString(), port: prepared.port }
}

/** Failures propagate to the durable review lease's retry/stop path. Never
 * report a revocation ack while an active gateway could still serve traffic. */
export async function revokeRunPreview(target: PreviewRevokeTarget, options: { leaseIds?: string[]; expiresAt?: string } = {}, connect: Connector = connectComputer, state: StateReader = computerState): Promise<void> {
  try {
    // Frozen gateways cannot serve traffic, but an ACK would lose the pending
    // nonce revocation before a normal resume. Keep the durable lease pending.
    if (await state(target.workspaceId, target.sandboxId) !== 'running') {
      if (options.leaseIds?.length && options.expiresAt && Number.isFinite(Date.parse(options.expiresAt)) && Date.parse(options.expiresAt) <= Date.now()) return
      throw new PreviewRuntimeError('scope_changed', 409)
    }
    const sandbox = await connect(target.workspaceId, target.sandboxId, AbortSignal.timeout(15_000))
    if (sandbox.sandboxId !== target.sandboxId) throw new PreviewRuntimeError('scope_changed', 409)
    const present = await sandbox.commands.run(`if test -S ${ROOT}/control.sock; then printf present; else printf absent; fi`, { user: 'root', timeoutMs: 5_000 })
    if (present.stdout === 'absent') return
    if (present.stdout !== 'present') throw new PreviewRuntimeError('protocol')
    const reply = await control(sandbox, { operation: 'revoke', runId: target.runId, ...(options.leaseIds ? { leaseIds: options.leaseIds } : {}) })
    if (reply.revoked !== true) throw new PreviewRuntimeError('protocol')
  } catch (cause) {
    if (computerGone(cause)) return
    if (cause instanceof PreviewRuntimeError) throw cause
    throw new PreviewRuntimeError('runtime', 503, { cause })
  }
}
