import 'server-only'
import type { TaskMachineGrant } from '../eve/cloudflare-task-connection'
import type { TaskReviewAuthority } from './review-authority'
import type { ReviewSessionKind, ReviewSessionLease } from './review-sessions'

export type CloudflareReview = { grant:TaskMachineGrant; scope:{
  leaseId:string; deviceId:string; repoId:string; sourceOperationId:string; bindingId:string; epoch:number
  kind:ReviewSessionKind; expiresAt:number; worktreePath:string
} }
export type ReviewCheckpoint = NonNullable<TaskMachineGrant['requiredCheckpoint']>
export function readReviewCheckpoint(value: unknown, instanceId: string): ReviewCheckpoint | undefined {
  if (!value || typeof value !== 'object') return
  const item = value as Partial<ReviewCheckpoint>
  if (item.instanceId === instanceId && /^[0-9a-f]{64}$/.test(instanceId) &&
      typeof item.id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(item.id) &&
      typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256))
    return {instanceId,id:item.id,sha256:item.sha256}
}
// Only the locked human lease and frozen product placement mint this tuple.
export function cloudflareReview(authority:TaskReviewAuthority, lease:ReviewSessionLease | null | undefined, kind:ReviewSessionKind): CloudflareReview {
  const placement = authority.sponsoredPlacement
  if (!placement || !authority.sandboxId || !lease?.reviewOperationId || lease.reviewKind !== kind ||
      authority.machineEpoch === null || !authority.nativeExitedProof) throw Error('Sponsored review lease unavailable')
  const expiresAt = Date.parse(lease.expiresAt)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error('Sponsored review lease expired')
  return {grant:{ownerId:authority.ownerId,workspaceId:authority.workspaceId,taskId:authority.taskId,runId:authority.runId,
    repositoryKey:placement.repositoryKey,operationId:lease.reviewOperationId,expiresAt,
    ...(placement.checkpoint ? {requiredCheckpoint:placement.checkpoint} : {})},
    scope:{leaseId:lease.id,deviceId:authority.deviceId,repoId:authority.repoId,sourceOperationId:placement.operationId,epoch:authority.machineEpoch,
      bindingId:authority.bindingId,worktreePath:authority.worktreePath,kind,expiresAt}}
}
export async function reviewRequest(review:CloudflareReview, action:string, fields:Record<string,unknown> = {}, signal?:AbortSignal) {
  const {taskReviewRequest} = await import('../eve/cloudflare-task-bridge')
  return taskReviewRequest(review.grant,{...fields,action,scope:review.scope},signal)
}
export async function reviewReply(review:CloudflareReview, action:string, fields:Record<string,unknown> = {}, signal?:AbortSignal) {
  const response = await reviewRequest(review,action,fields,signal)
  if (!response.ok) { await response.body?.cancel(); throw Error('Task review unavailable, HTTP '+response.status) }
  return await response.json() as Record<string,unknown>
}
export async function revokeCloudflareReview(target:{runId:string;ownerId:string;workspaceId:string;sandboxId:string;taskId:string;repositoryKey:string;operationId:string}, kind:ReviewSessionKind, leaseIds:string[]) {
  const {sandboxId,taskId,repositoryKey,operationId,ownerId,workspaceId,runId} = target
  const {taskReviewRequest} = await import('../eve/cloudflare-task-bridge')
  const reply = await taskReviewRequest({taskId,repositoryKey,operationId,ownerId,workspaceId,runId,expiresAt:0},{action:'revoke',kind,leaseIds})
  if (!reply.ok) { await reply.body?.cancel(); throw Error('Task review close unconfirmed') }
  const result = await reply.json()
  if (result.closed !== true) throw Error('Task review close unconfirmed')
  if (!result.stopped) return
  if (result.stopped.state !== 'stopped' || !result.stopped.stoppedAt || result.stopped.instanceId !== sandboxId)
    throw Error('Task review stop unconfirmed')
  return {checkpoint:readReviewCheckpoint({...result.stopped.checkpoint,instanceId:sandboxId},sandboxId)}
}
