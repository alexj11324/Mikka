import 'server-only'
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sandbox } from 'e2b'
import { connectComputer } from '@/lib/computer/e2b-provider'

export type BrowserBinding = { id: string; ownerId: string; workspaceId: string; botId: string; epoch: number; display?: number }
async function runtimeSources() {
  return Promise.all(['subagent-gateway.py', 'subagent-cdp.mjs'].map(name => readFile(join(process.cwd(), 'scripts/e2b', name))))
}
/** A running process does not reload replaced source files. Refuse capabilities
 * until the process itself reports the exact gateway and CDP launcher version. */
export async function verifyGatewayVersion(sandbox: Pick<Sandbox, 'commands'>) {
  const files = await runtimeSources()
  const expected = createHash('sha256').update(files[0]).update(files[1]).digest('hex')
  const result = await sandbox.commands.run('curl -fsS --max-time 2 http://127.0.0.1:6082/version', { user: 'root', timeoutMs: 5_000 })
  if (result.stdout.trim() !== expected) throw new Error('Browser runtime version mismatch')
}
export async function installSubagentRuntime(sandbox: Sandbox, ownerId: string) {
  // The machine's owner is immutable; installation never rotates a live key.
  await sandbox.commands.run('install -d -m 700 /run/mikka-subagents; test -f /run/mikka-subagents/key || (umask 077; head -c 32 /dev/urandom > /run/mikka-subagents/key)', { user: 'root' })
  const presence = await sandbox.commands.run('if test -f /run/mikka-subagents/owner; then echo existing; else echo absent; fi', { user: 'root', timeoutMs: 10_000 })
  if (presence.stdout.trim() === 'existing') {
    const existing = await sandbox.files.read('/run/mikka-subagents/owner', { user: 'root' })
    if (existing !== ownerId) throw new Error('Browser owner mismatch')
  } else if (presence.stdout.trim() === 'absent') {
    await sandbox.files.write('/run/mikka-subagents/owner', ownerId, { user: 'root' })
  } else throw new Error('Browser owner unavailable')
  for (const name of ['subagent-cdp.mjs', 'subagent-gateway.py']) {
    await sandbox.files.write(`/opt/mikka/computer/${name}`, await readFile(join(process.cwd(), 'scripts/e2b', name), 'utf8'), { user: 'root' })
  }
  await sandbox.commands.run('flock -n /run/mikka-subagents/gateway.lock /usr/bin/python3 /opt/mikka/computer/subagent-gateway.py', { user: 'root', background: true, timeoutMs: 0 })
  await sandbox.commands.run('for i in $(seq 1 30); do curl -fsS --max-time 1 http://127.0.0.1:6082/version >/dev/null && exit 0; sleep .2; done; exit 1', { user: 'root', timeoutMs: 10_000 })
  await verifyGatewayVersion(sandbox)
}
export type CredentialContinuation = { actionId: string; operation: 'submit' | 'clear'; targetId: string; origin: string; loaderId: string; inputs: { backendNodeId: number; credentialRole: 'username' | 'password' }[] }
export async function grant(sandbox: Sandbox, row: BrowserBinding, role: 'runtime' | 'view' | 'broker' | 'credential-continuation', credentialAction?: CredentialContinuation) {
  if ((role === 'credential-continuation') !== Boolean(credentialAction)) throw new Error('Invalid capability purpose')
  await verifyGatewayVersion(sandbox)
  const expiresAt = Date.now() + (role === 'broker' ? 90_000 : 120_000)
  const payload = Buffer.from(JSON.stringify({ ownerId: row.ownerId, workspaceId: row.workspaceId, botId: row.botId, subagentId: row.id, epoch: row.epoch, role, ...(credentialAction ? { credentialAction } : {}), ...(row.display ? { display: row.display } : {}), exp: Math.floor(expiresAt / 1000) })).toString('base64url')
  const key = await sandbox.files.read('/run/mikka-subagents/key', { user: 'root', format: 'bytes' })
  const token = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
  return { endpoint: `https://${sandbox.getHost(6082)}/agents/${row.id}?token=${token}`, expiresAt }
}
export function endpointPath(endpoint: string, path: string) {
  const url = new URL(endpoint); url.pathname += path; return url.toString()
}
export async function runtimeRequest(sandboxId: string, row: BrowserBinding, path: string, body?: unknown) {
  const sandbox = await connectComputer(row.workspaceId, sandboxId)
  const capability = await grant(sandbox, row, 'runtime')
  const response = await fetch(endpointPath(capability.endpoint, path), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25_000) })
  if (!response.ok) {
    if (response.status === 409) {
      const reason = (await response.text()).slice(0,100)
      if (reason === 'observation_stale' || reason === 'action_outcome_unknown') throw new Error(reason)
    }
    throw new Error('Browser runtime unavailable')
  }
  return await response.json() as Record<string, unknown>
}
