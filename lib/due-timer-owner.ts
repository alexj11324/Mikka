import type { getWorld } from 'workflow/runtime'
import type { getHookByToken } from 'workflow/api'
import { DUE_TIMER_LIFETIME_MS, wakeTokens } from './workflow-wake-tokens'

type World = Awaited<ReturnType<typeof getWorld>>
type RuntimeHook = Awaited<ReturnType<typeof getHookByToken>>
export type RecoveryTimerIdentity = { runId: string; workflowName: string; deploymentId: string; predecessorRunId?: string }
export type RecoveryTimerClaim = { state: 'take'; ownerId: string; projectId: string;
  previous: { runId: string; hookId: string; deploymentId: string; active: boolean } | null }
  | { state: 'handoff' | 'existing' }
export type RecoveryTimerState = 'current' | 'handoff' | 'lost'
const TOKEN = wakeTokens.dueTimer('run-recovery')
const active = (status: string) => status === 'pending' || status === 'running'
const terminal = (status: string) => status === 'completed' || status === 'failed' || status === 'cancelled'
const unavailable = () => new Error('due_timer_owner_unavailable')
const lifetimeElapsed = (run: { startedAt?: Date }) => {
  const started = run.startedAt?.getTime()
  // startedAt is the SDK's first actual execution time. createdAt could be
  // hours earlier while queued, so it cannot authorize same-deployment force.
  return started !== undefined && Number.isFinite(started) && Date.now() - started >= DUE_TIMER_LIFETIME_MS
}
const lifetimeSuccessor = (identity: RecoveryTimerIdentity, run: { runId: string; startedAt?: Date }) =>
  identity.predecessorRunId === run.runId && run.runId !== identity.runId && lifetimeElapsed(run)

/** This migration is deliberately not enabled in preview or for other jobs. */
export const productionRecoveryTimer = () => process.env.VERCEL_ENV === 'production'

async function runtime() {
  const world = await (await import('workflow/runtime')).getWorld()
  if (!productionRecoveryTimer() || world.getEnvironment?.() !== 'production' || !world.resolveLatestDeploymentId) throw unavailable()
  return world
}

async function latest(world: World) {
  const value = await world.resolveLatestDeploymentId?.()
  if (!value) throw unavailable()
  return value
}

async function lookup(token: string): Promise<RuntimeHook | null> {
  try { return await (await import('workflow/api')).getHookByToken(token) }
  catch (error) {
    // Only an explicit missing hook means no owner. Transport/authentication
    // errors must never start a competing timer.
    if (error instanceof Error && error.name === 'HookNotFoundError') return null
    throw error
  }
}

async function registered() {
  const { dueTimer } = await import('@/workflows/due-timer/workflow')
  // workflowId is the SDK's generated public start metadata. It is also what
  // start() validates; no private SDK path or hand-written workflow name.
  const workflowName = (dueTimer as typeof dueTimer & { workflowId?: string }).workflowId
  if (!workflowName) throw unavailable()
  return { dueTimer, workflowName }
}

async function matchingRun(world: World, hook: RuntimeHook, workflowName: string) {
  const run = await world.runs.get(hook.runId, { resolveData: 'none' })
  if ((!active(run.status) && !terminal(run.status)) || hook.token !== TOKEN || hook.environment !== 'production' || run.workflowName !== workflowName ||
      (hook.resumeContext && (hook.resumeContext.workflowName !== run.workflowName || hook.resumeContext.deploymentId !== run.deploymentId))) throw unavailable()
  return run
}

async function startLatest(world: World, predecessorRunId?: string) {
  await latest(world)
  const [{ start }, { dueTimer }] = await Promise.all([import('workflow/api'), registered()])
  await start(dueTimer, predecessorRunId ? ['run-recovery', predecessorRunId] : ['run-recovery'], { deploymentId: 'latest' })
}

/** Normal committed writes inspect the holder before waking any business code. */
export async function armCurrentRecoveryTimer() {
  const world = await runtime(), target = await latest(world)
  const [{ workflowName }, holder] = await Promise.all([registered(), lookup(TOKEN)])
  if (holder) {
    const run = await matchingRun(world, holder, workflowName)
    if (run.deploymentId === target && active(run.status)) {
      // Use the token, not a cached Hook: the SDK rechecks its current owner.
      await (await import('workflow/api')).resumeHook(TOKEN, {})
      return
    }
  }
  await startLatest(world)
}

/** A workflow step returns only deployment metadata, never a run payload. */
export async function recoveryTimerDeployment(): Promise<string | null> {
  if (!productionRecoveryTimer()) return null
  const world = await runtime(), deploymentId = await world.getDeploymentId()
  if (!deploymentId) throw unavailable()
  await latest(world)
  return deploymentId
}

async function ownRun(world: World, identity: RecoveryTimerIdentity) {
  if (await world.getDeploymentId() !== identity.deploymentId) throw unavailable()
  const run = await world.runs.get(identity.runId, { resolveData: 'none' })
  if (!active(run.status) || run.workflowName !== identity.workflowName || run.deploymentId !== identity.deploymentId) throw unavailable()
  return run
}

async function elected(world: World, identity: RecoveryTimerIdentity) {
  const run = await ownRun(world, identity)
  const hook = await lookup(wakeTokens.dueTimerDeployment('run-recovery', identity.deploymentId))
  if (!hook || hook.runId !== identity.runId || hook.environment !== 'production' || !hook.ownerId || !hook.projectId ||
      hook.resumeContext?.deploymentId !== identity.deploymentId || hook.resumeContext.workflowName !== identity.workflowName) throw unavailable()
  return { hook, run }
}

/** Non-force election precedes this check and the atomic global-token claim. */
export async function prepareRecoveryTimerClaim(identity: RecoveryTimerIdentity): Promise<RecoveryTimerClaim> {
  const world = await runtime(), { hook: election } = await elected(world, identity)
  if (await latest(world) !== identity.deploymentId) return { state: 'handoff' }
  const holder = await lookup(TOKEN)
  if (!holder) return { state: 'take', ownerId: election.ownerId, projectId: election.projectId, previous: null }
  if (holder.ownerId !== election.ownerId || holder.projectId !== election.projectId) throw unavailable()
  const run = await matchingRun(world, holder, identity.workflowName)
  if (active(run.status) && run.deploymentId === identity.deploymentId && !lifetimeSuccessor(identity, run)) return { state: 'existing' }
  // SDK 5.2.3 refuses force against active pre-v8 victims. Do not silently
  // replace that refusal with cancellation or an unguarded second timer.
  if (active(run.status) && (run.specVersion ?? 1) < 8) throw unavailable()
  return { state: 'take', ownerId: election.ownerId, projectId: election.projectId,
    previous: { runId: run.runId, hookId: holder.hookId, deploymentId: run.deploymentId, active: active(run.status) } }
}

async function owned(identity: RecoveryTimerIdentity, claim?: Extract<RecoveryTimerClaim, { state: 'take' }>) {
  const world = await runtime()
  // A retiring holder has released only its election. Its immutable claim
  // keeps the tenant scope while the global hook remains occupied.
  const proof = claim ? { hook: claim, run: await ownRun(world, identity) } : await elected(world, identity)
  const holder = await lookup(TOKEN)
  if (!holder || holder.runId !== identity.runId) return { world, holder: null, run: proof.run }
  if (holder.ownerId !== proof.hook.ownerId || holder.projectId !== proof.hook.projectId || holder.environment !== 'production' ||
      holder.resumeContext?.deploymentId !== identity.deploymentId || holder.resumeContext.workflowName !== identity.workflowName) throw unavailable()
  return { world, holder, run: proof.run }
}

/** Uses the World's atomic claimedFrom receipt, never a run id supplied by a user. */
export async function retirePreviousRecoveryTimer(identity: RecoveryTimerIdentity, claim: RecoveryTimerClaim): Promise<RecoveryTimerState> {
  if (claim.state !== 'take') throw unavailable()
  const { world, holder } = await owned(identity)
  if (!holder) return 'lost'
  if (holder.ownerId !== claim.ownerId || holder.projectId !== claim.projectId) throw unavailable()
  if (await latest(world) !== identity.deploymentId) return 'handoff'
  const previous = claim.previous, receipt = holder.claimedFrom
  if (receipt) {
    if (!previous || receipt.runId !== previous.runId || receipt.hookId !== previous.hookId || receipt.runId === identity.runId ||
        (receipt.workflowName && receipt.workflowName !== identity.workflowName) ||
        (receipt.deploymentId && receipt.deploymentId !== previous.deploymentId)) throw unavailable()
    const victim = await world.runs.get(receipt.runId, { resolveData: 'none' })
    if ((!active(victim.status) && !terminal(victim.status)) || victim.workflowName !== identity.workflowName || victim.deploymentId !== previous.deploymentId ||
        (active(victim.status) && victim.deploymentId === identity.deploymentId && !lifetimeSuccessor(identity, victim))) throw unavailable()
    // The token may have moved again while metadata was read. Never cancel
    // the replacement or run business work from a superseded candidate.
    if ((await lookup(TOKEN))?.runId !== identity.runId) return 'lost'
    if (active(victim.status)) await (await import('workflow/api')).getRun(victim.runId).cancel()
  } else if (previous?.active) {
    // The captured owner may have completed and released its hook between
    // prepare and force. Absence of claimedFrom never authorizes cancellation;
    // only that exact run's terminal metadata permits a fresh first pass.
    const victim = await world.runs.get(previous.runId, { resolveData: 'none' })
    if (!terminal(victim.status) || victim.workflowName !== identity.workflowName || victim.deploymentId !== previous.deploymentId) throw unavailable()
  }
  return currentRecoveryTimer(identity)
}

/** Called after a real hook event/deadline, not periodically while idle. */
export async function currentRecoveryTimer(identity: RecoveryTimerIdentity): Promise<RecoveryTimerState> {
  const { world, holder, run } = await owned(identity)
  if (!holder) return 'lost'
  return await latest(world) === identity.deploymentId && !lifetimeElapsed(run) ? 'current' : 'handoff'
}

/** The old holder keeps its hook until the new deployment atomically takes it. */
export async function handOffCurrentRecoveryTimer(identity: RecoveryTimerIdentity, claim: RecoveryTimerClaim) {
  if (claim.state !== 'take') throw unavailable()
  const { world, holder, run } = await owned(identity, claim)
  if (holder && (await latest(world) !== identity.deploymentId || lifetimeElapsed(run))) await startLatest(world, identity.runId)
}

/** A stale candidate that has not acquired the global hook only redirects. */
export async function redirectRecoveryTimer() { await startLatest(await runtime()) }
