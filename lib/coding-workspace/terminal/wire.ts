import { createHash, createHmac, randomUUID } from 'node:crypto'
import { TerminalError, TERMINAL_STATUS } from '@mikka/protocol/coding-terminal'
import type { TaskReviewAuthority } from '../review-authority'

export type TerminalOperation = 'stream' | 'input' | 'resize' | 'close' | 'revoke' | 'inspect'
export type TerminalLease = { id: string; expiresAt: string }
export type TerminalTarget = { runId: string; ownerId: string; workspaceId: string; sandboxId: string }
export type TerminalPrepared = { origin: string; boot: string; key: Buffer; bindingId: string }

/** Instance-specific key. The app secret itself never leaves the server. */
export function terminalKey(target: Pick<TerminalTarget, 'ownerId' | 'workspaceId' | 'sandboxId'>, secret: string | undefined) {
  if (!secret || secret.length < 32) throw new TerminalError('terminal_unavailable', { detail: 'configuration' })
  return createHmac('sha256', secret).update(JSON.stringify(['mikka:review-terminal:v1', target.workspaceId, target.ownerId, target.sandboxId])).digest()
}

/** Call inside the final short authority/lease transaction. The captured boot
 * nonce cannot be refreshed after that transaction: a revoke/restart winning
 * the network race must invalidate this exact, one-use authorization. */
export function terminalGrant(prepared: TerminalPrepared, scope: TaskReviewAuthority, lease: TerminalLease,
  operation: Exclude<TerminalOperation, 'revoke' | 'inspect'>, body = '', now = Date.now()) {
  const expiry = Date.parse(lease.expiresAt)
  if (prepared.bindingId !== scope.bindingId || !scope.sandboxId || !Number.isFinite(expiry) || expiry <= now || expiry > now + 300_000)
    throw new TerminalError('terminal_binding_changed')
  return signTerminalTicket(prepared.key, {
    version: 1, operation, boot: prepared.boot, nonce: randomUUID(), expiresAt: now + 30_000,
    bodyDigest: createHash('sha256').update(body).digest('hex'),
    sessionId: lease.id, sessionExpiresAt: Date.parse(lease.expiresAt),
    taskId: scope.taskId, runId: scope.runId, ownerId: scope.ownerId, workspaceId: scope.workspaceId,
    deviceId: scope.deviceId, repoId: scope.repoId, bindingId: scope.bindingId,
    machineEpoch: scope.machineEpoch, worktreePath: scope.worktreePath,
    credentialId: `${scope.credential.kind}:${scope.credential.id}`,
  })
}

export function signTerminalTicket(key: Buffer, value: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`
}

/** Remote bodies are untrusted diagnostics. Only closed public codes escape. */
export async function terminalResponseError(response: Response): Promise<TerminalError> {
  let value: unknown
  try {
    const reader = response.body?.getReader()
    if (reader) {
      let text = ''
      try {
        while (text.length <= 1024) {
          const item = await reader.read()
          if (item.done) break
          text += new TextDecoder().decode(item.value)
        }
        if (text.length <= 1024) value = JSON.parse(text)
      } finally { await reader.cancel(); reader.releaseLock() }
    }
  } catch { /* A malformed error body never becomes user-visible text. */ }
  const code = value && typeof value === 'object' && 'error' in value ? value.error : undefined
  if (typeof code === 'string' && Object.hasOwn(TERMINAL_STATUS, code)) return new TerminalError(code as keyof typeof TERMINAL_STATUS)
  return new TerminalError('terminal_unavailable', { detail: 'protocol' })
}
