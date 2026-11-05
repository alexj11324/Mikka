import { CodedError, logCodedError } from '@mikka/protocol/coded-error'
import { getWorkflowMetadata } from 'workflow'
import { getHookByToken, getRun, start } from 'workflow/api'
import { HookNotFoundError } from 'workflow/errors'
import { getWorld } from 'workflow/runtime'
import type { DueKind } from './due-timer'
import { wakeTokens } from './workflow-wake-tokens'

const WORKFLOW_NAME = 'workflow//./workflows/due-timer/workflow//dueTimer'
const terminal = (status: string) => status === 'completed' || status === 'failed' || status === 'cancelled'
type Detail = 'holder_scope' | 'candidate_scope' | 'force_unsupported' | 'claim_lost' | 'predecessor_scope' | 'predecessor_active'
type Diagnostic = { kind: DueKind; runId?: string; deploymentId?: string; holderRunId?: string; holderDeploymentId?: string; holderSpecVersion?: number; forceSupported?: boolean; previousRunId?: string; previousDeploymentId?: string; previousStatus?: string }
const safeId = (value: string | undefined) => value && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined
function unavailable(detail: Detail, fields: Diagnostic) {
  const error = new CodedError('due_timer_unavailable', { detail })
  logCodedError(error, {
    event: 'due_timer_claim_rejected', kind: fields.kind,
    runId: safeId(fields.runId), deploymentId: safeId(fields.deploymentId),
    holderRunId: safeId(fields.holderRunId), holderDeploymentId: safeId(fields.holderDeploymentId),
    holderSpecVersion: fields.holderSpecVersion !== undefined && Number.isFinite(fields.holderSpecVersion) ? fields.holderSpecVersion : undefined,
    forceSupported: fields.forceSupported, previousRunId: safeId(fields.previousRunId),
    previousDeploymentId: safeId(fields.previousDeploymentId), previousStatus: safeId(fields.previousStatus),
  })
  return error
}

export type DueTimerClaim = { mode: 'acquire'; force?: boolean; previousRunId?: string } | { mode: 'yield'; wake?: boolean }

async function latestDeployment() {
  const world = await getWorld()
  return world.resolveLatestDeploymentId ? world.resolveLatestDeploymentId() : world.getDeploymentId()
}

/** Only routing metadata is read: never hydrate the hook payload or run inputs/outputs. */
async function timerHolder(kind: DueKind) {
  let hook: Awaited<ReturnType<typeof getHookByToken>>
  try { hook = await getHookByToken(wakeTokens.dueTimer(kind)) }
  catch (error) { if (HookNotFoundError.is(error)) return null; throw error }
  const context = hook.resumeContext ?? await (await getWorld()).runs.get(hook.runId, { resolveData: 'none' })
  if (hook.token !== wakeTokens.dueTimer(kind) || context.workflowName !== WORKFLOW_NAME) throw unavailable('holder_scope', { kind, holderRunId: hook.runId, holderDeploymentId: context.deploymentId, holderSpecVersion: hook.specVersion })
  return { hook, deploymentId: context.deploymentId }
}

export async function startLatestDueTimer(kind: DueKind, predecessorRunId?: string) {
  const { dueTimer } = await import('@/workflows/due-timer/workflow')
  await start(dueTimer, predecessorRunId ? [kind, predecessorRunId] : [kind], { deploymentId: 'latest' })
}

/** Arming never cancels a holder: the successor must own the token first. */
export async function timerNeedsStart(kind: DueKind) {
  const [holder, latest] = await Promise.all([timerHolder(kind), latestDeployment()])
  return !holder || holder.deploymentId !== latest
}

/** Called under the Workflow election hook, so concurrent latest candidates re-read the actual holder. */
export async function prepareTimerClaim(kind: DueKind, predecessorRunId?: string): Promise<DueTimerClaim> {
  const world = await getWorld()
  const runId = getWorkflowMetadata().workflowRunId
  const [candidate, latest] = await Promise.all([world.runs.get(runId, { resolveData: 'none' }), latestDeployment()])
  if (candidate.workflowName !== WORKFLOW_NAME) throw unavailable('candidate_scope', { kind, runId, deploymentId: candidate.deploymentId })
  if (candidate.deploymentId !== latest) {
    await startLatestDueTimer(kind)
    return { mode: 'yield' }
  }
  const holder = await timerHolder(kind)
  if (!holder) return { mode: 'acquire' }
  // A same-deployment rotation is allowed only for the SDK-recorded child of
  // the actual holder. A caller-supplied predecessor string is not authority.
  const rotation = predecessorRunId === holder.hook.runId && candidate.attributes?.$parentRunId === holder.hook.runId
  if (holder.deploymentId === latest && !rotation) return { mode: 'yield', wake: true }
  if (!world.capabilities?.hookForceClaim || (holder.hook.specVersion ?? 0) < 8) throw unavailable('force_unsupported', { kind, runId, deploymentId: candidate.deploymentId, holderRunId: holder.hook.runId, holderDeploymentId: holder.deploymentId, holderSpecVersion: holder.hook.specVersion, forceSupported: Boolean(world.capabilities?.hookForceClaim) })
  return { mode: 'acquire', force: true, previousRunId: holder.hook.runId }
}

/** Stop future scheduling of the displaced Workflow before running new work.
 * Cancellation does not roll back an already-running old step. Keeping the
 * new global hook (even while idle) makes that step's late writes wake us. */
export async function completeTimerClaim(kind: DueKind, previousRunId?: string) {
  const runId = getWorkflowMetadata().workflowRunId
  const holder = await timerHolder(kind)
  if (holder?.hook.runId !== runId) throw unavailable('claim_lost', { kind, runId, holderRunId: holder?.hook.runId, holderDeploymentId: holder?.deploymentId })
  if (!previousRunId) return
  // Force records the actual displaced owner atomically. An old deployment can
  // release/re-take between inspection and force; retire that actual owner too.
  const displaced = new Set([previousRunId, holder.hook.claimedFrom?.runId].filter((id): id is string => Boolean(id)))
  const candidate = await (await getWorld()).runs.get(runId, { resolveData: 'none' })
  for (const previous of displaced) {
    const old = await (await getWorld()).runs.get(previous, { resolveData: 'none' })
    if (previous === runId || old.workflowName !== WORKFLOW_NAME || (old.deploymentId === holder.deploymentId && candidate.attributes?.$parentRunId !== previous)) throw unavailable('predecessor_scope', { kind, runId, deploymentId: holder.deploymentId, previousRunId: previous, previousDeploymentId: old.deploymentId })
    if (!terminal(old.status)) {
      try { await getRun(previous).cancel() }
      catch (error) { if (!terminal(await getRun(previous).status)) throw error }
    }
    const status = await getRun(previous).status
    if (!terminal(status)) throw unavailable('predecessor_active', { kind, runId, deploymentId: holder.deploymentId, previousRunId: previous, previousDeploymentId: old.deploymentId, previousStatus: status })
    console.info(JSON.stringify({ msg: 'due_timer_migrated', kind, runId, previousRunId: previous, deploymentId: holder.deploymentId, previousDeploymentId: old.deploymentId, previousStatus: status }))
  }
}
