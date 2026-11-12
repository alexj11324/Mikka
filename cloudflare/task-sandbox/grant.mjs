const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const repository = /^v2\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/i
export const MAX_RUN_MS = 15 * 60_000
export const CHECKPOINT_TIME_MS = 60_000

// Only the Mikka API service binding may construct this lease after checking the
// frozen product run. It is never accepted from a browser or an Actions issuer.
const hex = /^[0-9a-f]{64}$/
export function requiredCheckpoint(value) {
  if (!value || typeof value.instanceId !== 'string' || typeof value.id !== 'string' || typeof value.sha256 !== 'string' ||
      !hex.test(value.instanceId) || !uuid.test(value.id) || !hex.test(value.sha256)) {
    throw new Error('Invalid task machine grant')
  }
  return {instanceId:value.instanceId,id:value.id,sha256:value.sha256}
}

export function verifyCheckpoint(required, instanceId, saved) {
  if (required && (required.instanceId !== instanceId || required.id !== saved?.id || required.sha256 !== saved?.sha256)) {
    throw new Error('Original task checkpoint is unavailable')
  }
}

export function machineGrant(input) {
  if (!input || typeof input.ownerId !== 'string' || !input.ownerId || input.ownerId.length > 256 ||
      ![input.workspaceId, input.taskId, input.runId, input.operationId].every(v => typeof v === 'string' && uuid.test(v)) ||
      typeof input.repositoryKey !== 'string' || input.repositoryKey.length > 320 || !repository.test(input.repositoryKey) ||
      !Number.isSafeInteger(input.expiresAt)) throw new Error('Invalid task machine grant')
  const { ownerId, workspaceId, taskId, runId, operationId, expiresAt } = input
  return { ownerId, workspaceId, taskId, repositoryKey: input.repositoryKey.toLowerCase(), runId, operationId, expiresAt,
    ...(input.requiredCheckpoint === undefined ? {} : {requiredCheckpoint:requiredCheckpoint(input.requiredCheckpoint)}) }
}

export const workspaceName = ({ ownerId, workspaceId, taskId, repositoryKey }) =>
  JSON.stringify([ownerId, workspaceId, taskId, repositoryKey])

export function sameGrant(a, b) {
  return Boolean(a && b && workspaceName(a) === workspaceName(b) && a.runId === b.runId && a.operationId === b.operationId)
}

export function liveUntil(grant, now, hardDeadline) {
  const until = Math.min(grant.expiresAt, hardDeadline)
  if (until <= now) throw new Error('Task machine lease expired')
  return until
}
