import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import { deviceRequestCaller } from '@/lib/device-request-context'
import { verifyBearer } from '@/lib/cron-auth'
import { WorkspaceError } from '@/lib/workspace-error'

type Query = Pick<PoolClient, 'query'>
type Runtime = { workflowRunId: string; workflowName: string; stepId: string }
type Authority =
  | { source: 'cron'; secret: string }
  | { source: 'recovery'; runtime: Runtime }
  | { source: 'thread'; runtime: Runtime; userId: string; workspaceId: string; runId: string }
type HeldAuthority = Authority & { active: boolean; expiresAt: number }
const authority = new AsyncLocalStorage<HeldAuthority>()
const MAX_AUTHORITY_MS = 5 * 60_000

/** Runtime metadata is supplied by the Workflow executor's ALS, never a tool
 * argument, HTTP field, tracing label, or a caller-provided run id. */
async function workflowRuntime(): Promise<Runtime | undefined> {
  const { getWorkflowMetadata, getStepMetadata } = await import('workflow')
  try {
    const run = getWorkflowMetadata(), step = getStepMetadata()
    return run.workflowRunId && run.workflowName && step.stepId
      ? { workflowRunId: run.workflowRunId, workflowName: run.workflowName, stepId: step.stepId } : undefined
  } catch {
    // A step called as an ordinary function has no SDK execution authority.
    return undefined
  }
}
async function registeredRuntime(runtime: Runtime, kind: 'coordinator' | 'recovery' | 'thread'): Promise<boolean> {
  const workflows = kind === 'coordinator'
    ? [(await import('@/workflows/coordinator/workflow')).coordinatorTurn]
    : kind === 'recovery' ? [(await import('@/workflows/due-timer/workflow')).dueTimer]
      : [(await import('@/workflows/factory-stage/workflow')).factoryCloudStageHandoff,
        (await import('@/workflows/thread-machine/workflow')).threadMachineLifecycle]
  // workflowId is the SDK's public generated start metadata, also checked by
  // start(). Do not duplicate names or accept a suffix/prefix match.
  return workflows.some(workflow => (workflow as typeof workflow & { workflowId?: string }).workflowId === runtime.workflowName)
}
function sameRuntime(left: Runtime, right?: Runtime): boolean {
  return !!right && left.workflowName === right.workflowName && left.workflowRunId === right.workflowRunId && left.stepId === right.stepId
}
async function recoveryReceipt(runtime: Runtime): Promise<boolean> {
  const [{ getHookByToken }, { wakeTokens }] = await Promise.all([import('workflow/api'), import('@/lib/workflow-wake-tokens')])
  const token = wakeTokens.dueTimer('run-recovery')
  const hook = await getHookByToken(token)
  return hook.runId === runtime.workflowRunId && hook.token === token
}
async function runWithAuthority<T>(value: Authority, work: () => Promise<T>): Promise<T> {
  const held = { ...value, active: true, expiresAt: Date.now() + MAX_AUTHORITY_MS } as HeldAuthority
  try { return await authority.run(held, work) }
  finally { held.active = false }
}

/** Only the two authenticated recovery routes call this. Recheck the actual
 * credential here: knowing that another function returned null is not proof.
 * The credential stays in this short-lived private context and is never logged
 * or added to an Enterprise principal, task, audit row, or Workflow input. */
export async function withRecoveryCronAuthority<T>(request: Request, work: () => Promise<T>): Promise<T> {
  const secret = process.env.CRON_SECRET
  if (!secret || !await verifyBearer(request.headers.get('authorization'), secret)) throw new WorkspaceError('workspaceAccessDenied')
  return runWithAuthority({ source: 'cron', secret }, work)
}

/** The existing durable timer already owns its hook before runDue(). Verify
 * that receipt here too; a different timer or a direct function call gets no
 * execution authority. Ordinary non-Enterprise behavior remains unchanged. */
export async function withRecoveryWorkflowAuthority<T>(work: () => Promise<T>): Promise<T> {
  const runtime = await workflowRuntime()
  if (!runtime || !await registeredRuntime(runtime, 'recovery')) return work()
  if (!await recoveryReceipt(runtime)) return work()
  return runWithAuthority({ source: 'recovery', runtime }, work)
}

/** One real Factory/thread step pins its persisted run. This is not a public
 * constructor for a system principal. Every Enterprise gate rechecks the run,
 * its immutable requester/Workspace, issue and computer binding on the caller's
 * existing APP executor; queued and ended runs retain their own lifecycle. */
export async function withThreadWorkflowAuthority<T>(
  actor: { userId: string; workspaceId: string }, runId: string, work: () => Promise<T>,
): Promise<T> {
  const runtime = await workflowRuntime()
  if (!runtime || !await registeredRuntime(runtime, 'thread')) return work()
  return runWithAuthority({ source: 'thread', runtime, userId: actor.userId, workspaceId: actor.workspaceId, runId }, work)
}

/** undefined means no authenticated execution source. false means a source
 * exists but is invalid: callers must not fall back to another identity. The
 * caller still enforces membership, SCIM and allowMachineCredentials. */
export async function currentExecutionAuthority(userId: string, workspaceId: string, query: Query): Promise<boolean | undefined> {
  const device = deviceRequestCaller.getStore()
  if (device) {
    if (device.userId !== userId || device.removingDeviceId || (device.scopeWorkspaceId && device.scopeWorkspaceId !== workspaceId)) return false
    const { rows } = await query.query(`SELECT 1 FROM device_tokens t
      WHERE t.id=$1 AND t."userId"=$2 AND t."revokedAt" IS NULL AND (t."expiresAt" IS NULL OR t."expiresAt">clock_timestamp())
        AND ((t."boundDeviceId" IS NULL AND t."boundWorkspaceId" IS NULL AND $4::uuid IS NULL AND $5::uuid IS NULL
          AND NOT EXISTS (SELECT 1 FROM device_token_devices td JOIN devices d ON d.id=td."deviceId"
            WHERE td."tokenId"=t.id AND d."ownerId"=$2 AND d."removedAt" IS NOT NULL))
          OR (t."boundDeviceId"=$4 AND t."boundWorkspaceId"=$3 AND $5::uuid=$3 AND t."expiresAt" IS NOT NULL
            AND EXISTS (SELECT 1 FROM devices d WHERE d.id=$4 AND d."ownerId"=$2 AND d.kind='cloud' AND d.enabled AND d."removedAt" IS NULL)
            AND EXISTS (SELECT 1 FROM (SELECT "deviceId","workspaceId","ownerId" FROM cloud_machines
              UNION ALL SELECT "deviceId","workspaceId","ownerId" FROM thread_machines WHERE state<>'ended') m
              WHERE m."deviceId"=$4 AND m."workspaceId"=$3 AND m."ownerId"=$2)))`,
    [device.tokenId, userId, workspaceId, device.scopeDeviceId ?? null, device.scopeWorkspaceId ?? null])
    return rows.length > 0
  }
  const held = authority.getStore()
  if (held) {
    if (!held.active || held.expiresAt <= Date.now()) return false
    if (held.source === 'cron') return held.secret === process.env.CRON_SECRET
    const runtime = await workflowRuntime()
    if (!sameRuntime(held.runtime, runtime)) return false
    if (held.source === 'recovery') return recoveryReceipt(held.runtime)
    if (held.userId !== userId || held.workspaceId !== workspaceId) return false
    // Ending a thread retires its cloud device before the after-commit Factory
    // reconciliation. Only that exact terminal run's ended machine receipt may
    // authorize cleanup; a removed device alone never becomes a credential.
    const { rows } = await query.query(`SELECT 1 FROM agent_runs r
      JOIN issues i ON i.id=r."issueId" AND i."workspaceId"=r."workspaceId" AND i."ownershipState"='bound'
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId" AND b."workspaceId"=r."workspaceId"
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
        AND (d."removedAt" IS NULL OR (d.kind='cloud' AND r.status IN ('succeeded','failed','stopped','cancelled')
          AND EXISTS (SELECT 1 FROM thread_machines retired WHERE retired."runId"=r.id AND retired.state='ended'
            AND retired."ownerId"=r."userId" AND retired."workspaceId"=r."workspaceId" AND retired."deviceId"=d.id)))
      JOIN bots computer ON computer.id=b."botId" AND computer."ownerId"=r."userId" AND computer."workspaceId"=r."workspaceId" AND computer."archivedAt" IS NULL
      WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3
        AND r."agentDefinition"->'executionIdentity'->>'requester'=$2
        AND r."agentDefinition"->'executionIdentity'->>'executionPrincipal'=$2
        AND r."agentDefinition"->'executionIdentity'->>'outputOwner'=$2
        AND r."agentDefinition"->'executionIdentity'->>'workspaceId'=$3::text
        AND (r."agentDefinition"->'executionIdentity'->>'botId') IS NOT DISTINCT FROM r."botId"::text
        AND r."agentDefinition"->'executionIdentity'->'resourceBindings' @>
          jsonb_build_array(jsonb_build_object('kind','device','id',r."deviceId"::text,'ownerId',$2::text,'access','owner'))
        AND (r."botId" IS NULL OR EXISTS (SELECT 1 FROM bots bot WHERE bot.id=r."botId" AND bot."ownerId"=$2
          AND r."agentDefinition"->'executionIdentity'->>'botOwner'=bot."ownerId"
          AND bot."workspaceId"=$3 AND bot."archivedAt" IS NULL))`, [held.runId, userId, workspaceId])
    return rows.length > 0
  }
  const runtime = await workflowRuntime()
  if (!runtime || !await registeredRuntime(runtime, 'coordinator')) return undefined
  // The actual owner workflow must hold this exact Bot's live durable lease.
  // Tool call/occurrence checks remain at the original Coordinator step owner.
  const { rows } = await query.query(`SELECT 1 FROM coordinator_sessions s
    JOIN bots b ON b.id=s."botId" AND b."ownerId"=s."userId"
    WHERE s."userId"=$1 AND s."leaseHolder"=$3 AND s."leaseUntil">clock_timestamp()
      AND b."workspaceId"=$2 AND b."archivedAt" IS NULL`, [userId, workspaceId, runtime.workflowRunId])
  return rows.length > 0
}
