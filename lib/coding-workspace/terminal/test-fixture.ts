import { randomUUID } from 'node:crypto'
import type { TaskReviewAuthority } from '../review-authority'
import type { TerminalLease, TerminalPrepared } from './wire'

/** Synthetic identities only; no provider or database credentials. */
export function terminalFixture() {
  const scope: TaskReviewAuthority = {
    taskId: randomUUID(), runId: randomUUID(), userId: 'fixture-owner', ownerId: 'fixture-owner',
    workspaceId: randomUUID(), deviceId: randomUUID(), repoId: randomUUID(), deviceTokenId: randomUUID(),
    remoteKey: 'v2/github/fixture/project', repoPath: 'v2/github/fixture/project', worktreePath: '/workspace/fixture',
    machineKind: 'cloud', sandboxId: 'sandbox-synthetic', machineEpoch: 2, machineOperationId: randomUUID(),
    machineStatus: 'running', runStatus: 'succeeded', pauseReason: null, leaseExpiresAt: null,
    nativeExitedProof: true, bindingId: 'a'.repeat(64), deviceTokenActive: false,
    credential: { kind: 'session', id: 'browser-session-synthetic' }, credentialExpiresAt: null,
  }
  const lease: TerminalLease = { id: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const prepared: TerminalPrepared = { origin: 'https://6084-sandbox-synthetic.e2b.app',
    boot: randomUUID(), key: Buffer.alloc(32, 0x55), bindingId: scope.bindingId }
  return { scope, lease, prepared }
}
