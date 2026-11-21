import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { normalizeRepository } from '@mikka/protocol/repository'
import { runRepositorySelection } from '@mikka/protocol/run'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { threadRunModel } from '@/lib/computer/run-model'
import { queueCloudRun } from '@/lib/computer/queue-run'
import { queueFactoryRun } from '@/lib/agent-runs'
import { tiptapToText } from '@/lib/tiptap-text'
import { createFactoryDispatch, factoryBinding } from './dispatch'
import { factoryEventId } from './event-id'
import { notifyDeviceWork } from '../device-gateway-notify'
import type { FactoryTask, createFactoryStore } from './store'

/** The model chooses the repository, never the authority or execution callbacks. */
export const repositorySelectionRuntime = {
  queueCloud: queueCloudRun,
  queueLocal: queueFactoryRun,
  list: async (userId: string) => (await import('@/lib/github/user-access')).listRepositoriesForUser(userId),
  enqueue: async (pool: Pool, actor: { userId: string; workspaceId: string }, previous: string, next: string) =>
    (await import('./automatic-dispatch')).factoryAutomaticRuntime.enqueue(pool, actor, previous, next),
}

/** Called with the current Factory task and ended run locked. No old run, origin,
 * worktree or candidate is retargeted. A retry gets a new, admitted execution. */
export async function switchFactoryRepository(pool: Pool, tx: PoolClient, store: ReturnType<typeof createFactoryStore>, task: FactoryTask, run: Record<string, any>) {
  const refuse = async (reason: string) => {
    await store.apply(task.userId, factoryBinding(task), factoryEventId('repository-selection-refused', run.id), {
      action: 'finish', status: 'blocked', reason, evidence: [],
      output: { runId: run.id, reasonCode: 'repository_selection_refused' },
    }, tx)
    return undefined
  }
  const request = runRepositorySelection.safeParse(run.report?.repositorySelection)
  if (!request.success || task.stage !== 'execute' || task.status !== 'running' || run.stopRequestedAt || run.stopReason !== 'blocked' || !['failed', 'stopped'].includes(run.status) || !run.sessionId)
    return refuse('Repository selection requires the current, unstopped execution and a completed Agent handoff.')
  let target: ReturnType<typeof normalizeRepository>
  try {
    target = normalizeRepository(request.data.repository)
    if (!target.key.startsWith('v2/github.com/') || (run.remoteUrl && normalizeRepository(run.remoteUrl).key === target.key))
      return refuse('Select a different GitHub repository matching the task.')
    if ((run.remoteUrl === null) !== (request.data.observedRemote === null) || (run.remoteUrl && normalizeRepository(request.data.observedRemote!).key !== normalizeRepository(run.remoteUrl).key))
      return refuse('The observed Git origin does not match this execution’s bound repository.')
  } catch { return refuse('Repository identity is invalid; no workspace was switched.') }
  const { rows: history } = await tx.query(`SELECT output->'repositorySelection' AS selection FROM factory_attempts WHERE "taskId"=$1 AND output ? 'repositorySelection'`, [task.id])
  if (history.length >= 3 || history.some(row => row.selection?.target === target.key)) return refuse('Repository selection repeated or exceeded three switches; existing work is retained.')
  // Use the same live user/App intersection as ordinary repository dispatch.
  // A stored device_repos row or an Agent-supplied URL is never a grant.
  let authorized: Awaited<ReturnType<typeof repositorySelectionRuntime.list>>
  try { authorized = await repositorySelectionRuntime.list(task.userId) }
  catch { return refuse('GitHub authorization could not be verified; existing work is retained.') }
  const repository = authorized.repositories.find(row => `v2/github.com/${row.fullName.toLowerCase()}` === target.key)
  if (!repository) return refuse('The selected repository is outside the owner’s current GitHub authorization.')
  target = normalizeRepository(repository.fullName)
  const selection = threadRunModel(run.agentDefinition)
  if (!selection) return refuse('The execution’s frozen model is unavailable; no fallback was selected.')
  const { rows: [source] } = await tx.query(`SELECT d.kind,b."workspaceId",b."botId" AS "runtimeBotId",a.harness FROM devices d JOIN agents a ON a.id=$2 AND a."userId"=$3 LEFT JOIN computer_run_bindings b ON b."runId"=$1 AND b."ownerId"=$3 WHERE d.id=$4 AND d."ownerId"=$3 AND d.enabled=true`, [run.id, run.agentId, task.userId, run.deviceId])
  if (!source || source.harness !== run.agentDefinition?.harness) return refuse('The execution device, harness or owner authority is unavailable.')
  if (!task.workspaceId) return refuse('The task workspace is unavailable.')
  const cloud = source.kind === 'cloud'
  const runtime = cloud ? (await tx.query(`SELECT r."agentId",a."deviceId" FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."ownerId" WHERE r."botId"=$1 AND r."ownerId"=$2 AND r."workspaceId"=$3 AND r.harness=$4`, [source.runtimeBotId, task.userId, source.workspaceId, source.harness])).rows[0] : { agentId: run.agentId, deviceId: run.deviceId }
  if (!runtime) return refuse('The original execution runtime is unavailable.')
  // GitHub access is necessary but cannot enlarge tenant/project policy.
  try {
    const { withProjectExecution } = await import('@/lib/project-resources/store')
    await withProjectExecution({ userId: task.userId, workspaceId: task.workspaceId, issueId: task.issueId,
      repositoryKey: target.key, baseBranch: null, runtime: cloud ? 'cloud' : 'local', harness: source.harness }, async () => undefined, true)
  } catch (error) {
    const { ActionFailureError } = await import('@/lib/action-error')
    if (!(error instanceof ActionFailureError)) throw error
    return refuse('The selected repository or environment is outside the current workspace or project policy.')
  }
  const repo = await ensureDeviceRepository(task.userId, runtime.deviceId, target.remoteUrl, tx)
  const ended = await store.apply(task.userId, factoryBinding(task), factoryEventId('repository-selection', run.id), {
    action: 'finish', status: 'blocked', reason: 'The executing Agent selected another authorized repository.', evidence: [],
    output: { runId: run.id, repositorySelection: { ...request.data, target: target.key, previousRunId: run.id } },
  }, tx)
  const next = await store.apply(task.userId, factoryBinding(ended.task), factoryEventId('repository-selection-retry', run.id), {
    action: 'retry', reason: `Continue in ${repository.fullName}; retain the previous checkout.`,
  }, tx)
  const note = `The previous execution (${run.id}) selected ${repository.fullName}: ${request.data.reason}\nInspect this new checkout against the original task and continue. Previous work remains in the original checkout; do not assume it was copied here. Preserve the original task's delivery and acceptance requirements.`
  const readOnly = Boolean(run.agentDefinition?.readOnly)
  const actor = { userId: task.userId, workspaceId: source.workspaceId as string }
  const { rows: [issue] } = await tx.query('SELECT title,content FROM issues WHERE id=$1', [task.issueId])
  const dispatch = createFactoryDispatch(pool, store, cloud
    ? (client, _owner, _input, _bot, context) => repositorySelectionRuntime.queueCloud(pool, actor, {
      botId: source.runtimeBotId, issueId: task.issueId, agentId: runtime.agentId, deviceRepoId: repo.id,
      title: issue.title, body: tiptapToText(issue.content), note, ...selection, readOnly, withoutBot: task.botId === null,
      idempotencyKey: `factory:${context.attemptId}`,
    }, client)
    : (client, owner, input, bot, context) => repositorySelectionRuntime.queueLocal(client, owner, input, bot, context, undefined, { ...selection, readOnly }))
  const queued = await dispatch(task.userId, { binding: factoryBinding(next.task), agentId: runtime.agentId, deviceRepoId: repo.id, note }, tx)
  const { rows: [frozen] } = await tx.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])
  const actual = threadRunModel(frozen?.agentDefinition)
  if (!actual || actual.model !== selection.model || actual.subscriptionBindingId !== selection.subscriptionBindingId || actual.apiKeyId !== selection.apiKeyId || Boolean(frozen?.agentDefinition?.readOnly) !== readOnly)
    throw new Error('repository_selection_execution_changed')
  // The relation retains thread history. Daemon worktree reuse also requires
  // matching repository identity, so a new repository always gets a new clone.
  await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1 AND "userId"=$3', [queued.runId, run.id, task.userId])
  if (cloud) return async () => {
    try { await repositorySelectionRuntime.enqueue(pool, actor, run.id, queued.runId) }
    catch { await (await import('./cloud-stage-handoff')).failFactoryCloudStage(pool, actor, queued.runId, 'Repository handoff could not be queued') }
  }
  return async () => { notifyDeviceWork(runtime.deviceId) }
}
