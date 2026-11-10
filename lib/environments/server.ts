import 'server-only'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { afterJob } from '@/lib/background'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { discoverRunWorktree } from '@/lib/coding-workspace/identity'
import { pool } from '@/lib/db'
import { environmentExecutionChanged } from '@/lib/live/lists'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { withCredentialMasking } from '@/lib/secrets/mask'
import { secretMaskerFor } from '@/lib/secrets/runtime'
import { workspacePool } from '@/lib/workspace-db'
import { abortRunAction } from './active'
import { killSandboxProcess } from './backend'
import {
  environmentActionCwd, environmentActionFor, environmentAllowsRepository, EnvironmentRequestError,
  type EnvironmentSnapshot,
} from './contract'
import {
  cancelExecution, createRunActionExecution, environmentSnapshot, executionSummary, executionView,
  listRunActionExecutions, markExecutionCancelledIfQueued, readRunActionExecution, readRunEnvironmentBinding,
  runActionMachine,
} from './runs'
import { runActionExecution } from './runner'

const requestSchema = z.strictObject({ actionId: z.uuid(), requestKey: z.uuid().optional() }).strict()
const noStore = { 'Cache-Control': 'private, no-store' } as const
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore })

type OwnedRun = { id: string; userId: string; workspaceId: string | null; issueId: string | null; repositoryKey: string }

async function ownedRun(runId: string, userId: string, scopedWorkspace: string | null): Promise<OwnedRun | null> {
  const { rows: [run] } = await pool.query<OwnedRun>(
    `SELECT r.id,r."userId",r."workspaceId",r."issueId",repo."repoPath" AS "repositoryKey"
     FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
     WHERE r.id=$1 AND r."userId"=$2`, [runId, userId])
  if (!run?.workspaceId || (scopedWorkspace && scopedWorkspace !== run.workspaceId)) return null
  const member = await workspacePool.query(
    `SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`,
    [run.workspaceId, userId])
  return member.rowCount ? run : null
}

function failure(error: unknown): NextResponse {
  if (error instanceof EnvironmentRequestError) return respond({ error: error.code }, error.status)
  if (error instanceof CodingWorkspaceError) {
    const status = error.code === 'workspace_not_found' ? 404 : error.code === 'workspace_invalid_request' ? 400 : 409
    return respond({ error: error.code }, status)
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) return respond({ error: 'environmentInvalid' }, 400)
  return respond({ error: 'environmentUnavailable' }, 500)
}

async function session(request: Request) {
  const result = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  return result?.user ? { userId: result.user.id, scopedWorkspace: result.user[tokenWorkspace] ?? null } : null
}

/** GET /api/runs/[runId]/actions: the frozen environment and recent executions. */
export async function runActionsResponse(request: Request, runId: string): Promise<NextResponse> {
  try {
    const user = await session(request)
    if (!user) return respond({ error: 'authRequired' }, 401)
    const run = await ownedRun(runId, user.userId, user.scopedWorkspace)
    if (!run) return respond({ error: 'environmentNotFound' }, 404)
    const binding = await readRunEnvironmentBinding(pool, runId)
    const environment: EnvironmentSnapshot | null = binding ? environmentSnapshot(binding) : null
    const [executions, machine] = await Promise.all([
      listRunActionExecutions(pool, runId),
      runActionMachine(pool, runId, user.userId, run.workspaceId!),
    ])
    return respond({
      runId,
      environment,
      machine: machine?.deviceKind === 'cloud' && machine.machineState === 'running' && machine.sandboxId
        ? 'cloud_running' : machine?.deviceKind === 'local' ? 'local' : 'unavailable',
      executions: executions.map(executionSummary),
    })
  } catch (error) { return failure(error) }
}

/** POST /api/runs/[runId]/actions: queue one frozen action on the run's own machine. */
export async function requestRunActionResponse(request: Request, runId: string): Promise<NextResponse> {
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'originMismatch' }, 403)
    const user = await session(request)
    if (!user) return respond({ error: 'authRequired' }, 401)
    const body = requestSchema.parse(await request.json().catch(() => null))
    const run = await ownedRun(runId, user.userId, user.scopedWorkspace)
    if (!run) return respond({ error: 'environmentNotFound' }, 404)
    const binding = await readRunEnvironmentBinding(pool, runId)
    if (!binding) return respond({ error: 'environmentUnbound' }, 409)
    const environment = environmentSnapshot(binding)
    const action = environmentActionFor(environment, body.actionId)
    if (!action) return respond({ error: 'environmentActionNotFound' }, 409)
    if (!environmentAllowsRepository(environment, run.repositoryKey)) return respond({ error: 'environmentRepositoryNotAllowed' }, 409)
    // Full Coding Workspace identity: actor, tenant, repository, live lease.
    await discoverRunWorktree(pool, workspacePool, { userId: user.userId, workspaceId: run.workspaceId! }, runId)
    const machine = await runActionMachine(pool, runId, user.userId, run.workspaceId!)
    if (machine?.deviceKind !== 'cloud' || machine.machineState !== 'running' || !machine.sandboxId || !machine.worktreePath)
      return respond({ error: 'environmentMachineUnsupported' }, 409)
    const masker = withCredentialMasking(await secretMaskerFor({ workspaceId: run.workspaceId!, ownerId: user.userId }))
    const result = await createRunActionExecution(pool, {
      id: randomUUID(), runId, ownerId: user.userId, workspaceId: run.workspaceId!,
      environmentId: environment.environmentId, environmentRevision: environment.revision,
      actionId: action.id, actionName: action.name, actionKind: action.kind,
      command: masker(action.command), cwd: environmentActionCwd(machine.worktreePath, environment.workdir),
      sandboxId: machine.sandboxId, timeoutSeconds: action.timeoutSeconds,
      requestKey: body.requestKey ?? null, requestedBy: user.userId,
    })
    if (result.kind === 'busy') return respond({ error: 'environmentActionBusy' }, 409)
    if (result.kind === 'replayed') return respond({ execution: executionView(result.execution), replayed: true })
    const execution = result.execution
    afterJob('after:run-action', () => runActionExecution({ database: pool, executionId: execution.id }).catch(() => undefined))
    return respond({ execution: executionView(execution) }, 202)
  } catch (error) { return failure(error) }
}

/** GET /api/runs/[runId]/actions/[executionId]: one execution with its logs. */
export async function runActionExecutionResponse(request: Request, runId: string, executionId: string): Promise<NextResponse> {
  try {
    const user = await session(request)
    if (!user) return respond({ error: 'authRequired' }, 401)
    const run = await ownedRun(runId, user.userId, user.scopedWorkspace)
    if (!run) return respond({ error: 'environmentNotFound' }, 404)
    const execution = await readRunActionExecution(pool, runId, executionId)
    if (!execution) return respond({ error: 'environmentNotFound' }, 404)
    return respond({ execution: executionView(execution) })
  } catch (error) { return failure(error) }
}

/** POST /api/runs/[runId]/actions/[executionId]/cancel: kill a queued or running command. */
export async function cancelRunActionResponse(request: Request, runId: string, executionId: string): Promise<NextResponse> {
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'originMismatch' }, 403)
    const user = await session(request)
    if (!user) return respond({ error: 'authRequired' }, 401)
    const run = await ownedRun(runId, user.userId, user.scopedWorkspace)
    if (!run) return respond({ error: 'environmentNotFound' }, 404)
    const current = await readRunActionExecution(pool, runId, executionId)
    if (!current) return respond({ error: 'environmentNotFound' }, 404)
    if (current.status === 'queued' || current.status === 'running') {
      const row = await cancelExecution(pool, runId, executionId)
      if (row) {
        abortRunAction(executionId)
        if (row.status === 'queued') await markExecutionCancelledIfQueued(pool, executionId)
        if (row.sandboxId && row.pid) await killSandboxProcess(row.workspaceId, row.sandboxId, row.pid).catch(() => false)
        await environmentExecutionChanged(pool, runId).catch(() => undefined)
      }
    }
    const execution = await readRunActionExecution(pool, runId, executionId)
    return respond({ execution: execution ? executionView(execution) : null })
  } catch (error) { return failure(error) }
}
