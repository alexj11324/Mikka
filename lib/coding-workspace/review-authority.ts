import 'server-only'
import { hostedSnapshot, sponsoredReviewPlacement } from '../cloud-computer/sponsored-task'
import { readReviewCheckpoint, type ReviewCheckpoint } from './cloudflare-review'
import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { CodedError, type CodedErrorOptions } from '@mikka/protocol/coded-error'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import type { ApiSession } from '../api-auth'
import { readIssueMetadata } from '../issue-metadata'
import { tokenWorkspace } from '../tokens/principal'
import { taskThreadRunPredicate } from '../task-thread-run'

export type ReviewAuthorityCode = 'review_auth_required' | 'review_not_found' | 'not_owner_terminal'
  | 'review_scope_denied' | 'review_machine_gone' | 'review_binding_changed' | 'review_checkout_unavailable'
export class ReviewAuthorityError extends CodedError<ReviewAuthorityCode> {
  readonly status: number
  constructor(code: ReviewAuthorityCode, options: CodedErrorOptions = {}) {
    super(code, options)
    this.status = code === 'review_auth_required' ? 401
      : code === 'not_owner_terminal' || code === 'review_scope_denied' ? 403
        : code === 'review_machine_gone' || code === 'review_binding_changed' ? 409 : 404
  }
}

export type ReviewCredential = { kind: 'session' | 'pat'; id: string }
/** Control-plane identity only. It contains neither a credential value nor a
 * user-selectable host/port. A data-plane capability must also be revocable. */
export type TaskReviewAuthority = {
  taskId: string; runId: string; userId: string; ownerId: string; workspaceId: string
  deviceId: string; repoId: string; deviceTokenId: string; remoteKey: string
  /** device_repos.repoPath is a repository identity, not necessarily a path. */
  repoPath: string; worktreePath: string; machineKind: 'cloud' | 'local'
  sandboxId: string | null; machineEpoch: number | null; machineOperationId: string | null
  machineStatus: string; runStatus: string; pauseReason: string | null
  leaseExpiresAt: string | null; nativeExitedProof: boolean; bindingId: string
  /** A parked completed run keeps its old claim only as provenance. */
  sponsoredPlacement?: { operationId:string; repositoryKey:string; checkpoint?:ReviewCheckpoint }
  deviceTokenActive: boolean
  credential: ReviewCredential; credentialExpiresAt: string | null
}
export type ReviewAuthorityExpectation = { runId?: string; bindingId?: string; workspaceId?: string }

type Run = {
  id: string; userId: string; issueId: string; deviceId: string | null; deviceRepoId: string | null
  deviceTokenId: string | null; worktreePath: string | null; status: string; pauseReason: string | null
  leaseExpiresAt: Date | null; stopRequestedAt: Date | null; startedAt: Date | null; finishedAt: Date | null
  sessionId: string | null; attempt: number; machineAuthority: boolean
  storedWorkspace: string | null; frozenWorkspace: string | null; admissionWorkspace: string | null; admissionDevice: string | null
  admissionOwner: string | null; admissionTask: string | null
  frozenKey: string | null; botWorkspace: string | null
  bindingWorkspace: string | null; bindingOwner: string | null
  taskProvider: string | null; safeExit: boolean; exitObservedAt: string | null
}
type Device = { id: string; ownerId: string; kind: string; enabled: boolean; removedAt: Date | null }
type Repository = { id: string; userId: string; deviceId: string; repoPath: string; remoteUrl: string | null }
type Machine = { runId: string; ownerId: string; workspaceId: string; issueId: string | null; deviceId: string | null
  repoId: string | null; sandboxId: string | null; snapshotId:string | null; epoch: number; operationId: string; state: string; lifecycle: { phase?: string; sponsoredPreparedCheckpoint?:unknown } }
type DeviceToken = { id: string; userId: string; boundWorkspaceId: string | null; boundDeviceId: string | null
  revokedAt: Date | null; revokedBy: string | null; explicitRevocation: boolean; expiresAt: Date | null }
const ACTIVE = new Set(['preparing', 'running', 'paused', 'waiting_input', 'finishing'])
const ENDED = new Set(['succeeded', 'failed'])
const denied = () => new ReviewAuthorityError('review_scope_denied')

const RUN_COLUMNS = `r.id,r."userId",r."issueId",r."deviceId",r."deviceRepoId",r."deviceTokenId",r."worktreePath",
  r.status,r."pauseReason",r."leaseExpiresAt",r."stopRequestedAt",r."startedAt",r."finishedAt",r."sessionId",r.attempt,r."machineAuthority",
  r."workspaceId" AS "storedWorkspace",r."agentDefinition"#>>'{taskMachine,provider}' AS "taskProvider",
  r."agentDefinition"#>>'{executionIdentity,workspaceId}' AS "frozenWorkspace",
  r."agentDefinition"#>>'{repositoryAdmission,workspaceId}' AS "admissionWorkspace",
  r."agentDefinition"#>>'{repositoryAdmission,deviceId}' AS "admissionDevice",
  r."agentDefinition"#>>'{repositoryAdmission,userId}' AS "admissionOwner",
  r."agentDefinition"#>>'{repositoryAdmission,issueId}' AS "admissionTask",
  r."agentDefinition"#>>'{repositoryAdmission,remoteKey}' AS "frozenKey",
  b."workspaceId" AS "botWorkspace",c."workspaceId" AS "bindingWorkspace",c."ownerId" AS "bindingOwner",
  COALESCE(r.report->'safePoint'->>'session'='exited',false) AS "safeExit",r.report->'safePoint'->>'observedAt' AS "exitObservedAt"`
const RUN_JOINS = `LEFT JOIN bots b ON b.id=r."botId" LEFT JOIN computer_run_bindings c ON c."runId"=r.id`
const MACHINE_COLUMNS = '"runId","ownerId","workspaceId","issueId","deviceId","repoId","sandboxId","snapshotId",epoch,"operationId",state,lifecycle'

function credentialOf(session: ApiSession): ReviewCredential {
  if (!session.user.id || !session.session.id) throw new ReviewAuthorityError('review_auth_required')
  const pat = session.session.id.startsWith('pat:')
  if (pat && (!session.tokenWorkspaceId || session.user[tokenWorkspace] !== session.tokenWorkspaceId)) throw denied()
  return { kind: pat ? 'pat' : 'session', id: pat ? session.session.id.slice(4) : session.session.id }
}

async function lockCredential(client: PoolClient, session: ApiSession, credential: ReviewCredential): Promise<string | null> {
  const found = credential.kind === 'session'
    ? await client.query<{ expiresAt: Date | null }>('SELECT "expiresAt" FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE', [credential.id, session.user.id])
    : await client.query<{ expiresAt: Date | null }>(`SELECT "expiresAt" FROM personal_access_tokens WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3
      AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp()) FOR SHARE`, [credential.id, session.user.id, session.tokenWorkspaceId])
  if (!found.rowCount) throw new ReviewAuthorityError('review_auth_required')
  return found.rows[0]!.expiresAt?.toISOString() ?? null
}

async function taskForActor(database: Pool | PoolClient, session: ApiSession, taskId: string) {
  const { issueForUser } = await import('../issue-access')
  const issue = await issueForUser(session.user, taskId, false, drizzle(database), { withoutBody: true })
  if (!issue) throw new ReviewAuthorityError('review_not_found')
  // A human assignee is responsibility, not permission to another person's
  // private machine. Both this check and run.userId must match the actor.
  const assignee = readIssueMetadata(issue.content).assignee
  const ownerId = assignee?.kind === 'member' ? assignee.id : issue.userId
  if (ownerId !== session.user.id) throw new ReviewAuthorityError('not_owner_terminal')
  if (['done', 'canceled', 'duplicate'].includes(issue.status)) throw new ReviewAuthorityError('review_machine_gone')
  return issue
}

/** One bounded authorization read when opening or changing a capability.
 * Never call this per output chunk, websocket frame or static resource.
 * Workspace/member locks precede APP task/run locks, matching deletion.
 * The caller repeats with expected binding after asynchronous installation. */
export type ReviewAuthorityWork<T> = (authority: TaskReviewAuthority, client: PoolClient) => Promise<T>
export function resolveTaskReviewAuthority(database: Pool, membership: Pool, session: ApiSession,
  taskId: string, expected?: ReviewAuthorityExpectation): Promise<TaskReviewAuthority>
export function resolveTaskReviewAuthority<T>(database: Pool, membership: Pool, session: ApiSession,
  taskId: string, expected: ReviewAuthorityExpectation, work: ReviewAuthorityWork<T>): Promise<T>
export async function resolveTaskReviewAuthority<T>(database: Pool, membership: Pool, session: ApiSession,
  taskId: string, expected: ReviewAuthorityExpectation = {}, work?: ReviewAuthorityWork<T>): Promise<T | TaskReviewAuthority> {
  if (!z.uuid().safeParse(taskId).success) throw new ReviewAuthorityError('review_not_found')
  const credential = credentialOf(session)
  const initialTask = await taskForActor(database, session, taskId)
  // Task tenancy is authoritative even without a Team link. Legacy pending
  // rows cannot borrow a workspace from a Bot, Run or retained machine.
  const workspaceId = initialTask.workspaceId
  if (initialTask.ownershipState !== 'bound' || !workspaceId || !z.uuid().safeParse(workspaceId).success
    || session.tokenWorkspaceId && session.tokenWorkspaceId !== workspaceId) throw denied()
  if (expected.workspaceId !== undefined && expected.workspaceId !== workspaceId) throw denied()
  // Match the same Task execution category as review context / latestTaskRun.
  // Factory checkers and group chats never replace the person's checkout.
  // Filtering by owner or machine here would silently fall back after handoff.
  const { rows: [initial] } = await database.query<Run>(`SELECT ${RUN_COLUMNS} FROM agent_runs r ${RUN_JOINS}
    WHERE r."issueId"=$1 AND ${taskThreadRunPredicate('r')} ORDER BY r."createdAt" DESC,r.id DESC LIMIT 1`, [taskId])
  if (!initial) throw new ReviewAuthorityError('review_not_found')
  if (initial.userId !== session.user.id) throw new ReviewAuthorityError('not_owner_terminal')
  if (expected.runId && expected.runId !== initial.id) throw new ReviewAuthorityError('review_binding_changed')
  if (initial.status === 'stopped' || initial.status === 'cancelled') throw new ReviewAuthorityError('review_machine_gone')
  if (!ACTIVE.has(initial.status) && !ENDED.has(initial.status)) throw new ReviewAuthorityError('review_checkout_unavailable')
  const workspace = await membership.connect()
  let client: PoolClient | undefined, workspaceOpen = false, appOpen = false
  try {
    await workspace.query('BEGIN'); workspaceOpen = true
    await workspace.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='20s'")
    // All admissions and grouping writers lock Workspace/member first. Taking
    // the relation lock earlier would deadlock a tenant admin waiting on us.
    const home = await workspace.query<{ kind: string; userId: string }>('SELECT kind,"userId" FROM mikka_workspaces WHERE id=$1 FOR SHARE', [workspaceId])
    const member = await workspace.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`, [workspaceId, session.user.id])
    if (!home.rowCount || !member.rowCount || home.rows[0]!.kind === 'personal' && home.rows[0]!.userId !== session.user.id) throw denied()
    // The shared lock still fences insertion when this task has no Team link.
    await workspace.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))")
    const links = await workspace.query<{ workspaceId: string; teamId: string }>('SELECT "workspaceId","teamId" FROM mikka_team_issues WHERE "issueId"=$1 FOR SHARE', [taskId])
    if (links.rows.some(link => link.workspaceId !== workspaceId)) throw denied()
    for (const link of links.rows) if (!(await workspace.query('SELECT id FROM mikka_teams WHERE id=$1 AND "workspaceId"=$2 FOR SHARE', [link.teamId, workspaceId])).rowCount) throw denied()

    client = await database.connect(); await client.query('BEGIN'); appOpen = true
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='20s'")
    const credentialExpiresAt = await lockCredential(client, session, credential)
    // A grant serializes with a new Run's FK KEY SHARE on this Task. A plain
    // SHARE lock would let its revocation trigger run before our lease INSERT.
    const { rows: [lockedTask] } = await client.query<{ workspaceId: string | null; ownershipState: string }>(
      `SELECT "workspaceId","ownershipState" FROM issues WHERE id=$1 FOR ${work ? 'UPDATE' : 'SHARE'}`, [taskId])
    if (!lockedTask) throw new ReviewAuthorityError('review_not_found')
    if (lockedTask.ownershipState !== 'bound' || lockedTask.workspaceId !== workspaceId) throw denied()
    await taskForActor(client, session, taskId)
    if ((await client.query('SELECT 1 FROM workspace_deletions WHERE id=$1', [workspaceId])).rowCount) throw denied()
    const { rows: [run] } = await client.query<Run>(`SELECT ${RUN_COLUMNS} FROM agent_runs r ${RUN_JOINS}
      WHERE r."issueId"=$1 AND ${taskThreadRunPredicate('r')} ORDER BY r."createdAt" DESC,r.id DESC LIMIT 1 FOR SHARE OF r`, [taskId])
    if (!run || run.id !== initial.id) throw new ReviewAuthorityError('review_binding_changed')
    // A Factory bind can hold Run UPDATE while the SELECT above waits with an
    // earlier snapshot. Re-read classification after obtaining Run SHARE;
    // that lock now prevents another bind before our capability commits.
    const { rows: [currentThread] } = await client.query<{ id: string }>(`SELECT r.id FROM agent_runs r
      WHERE r."issueId"=$1 AND ${taskThreadRunPredicate('r')} ORDER BY r."createdAt" DESC,r.id DESC LIMIT 1`, [taskId])
    if (currentThread?.id !== run.id) throw new ReviewAuthorityError('review_binding_changed')
    if (run.userId !== session.user.id) throw new ReviewAuthorityError('not_owner_terminal')
    if (!run.deviceId || !run.deviceRepoId || !run.deviceTokenId) throw new ReviewAuthorityError('review_machine_gone')
    const { rows: [device] } = await client.query<Device>('SELECT id,"ownerId",kind,enabled,"removedAt" FROM devices WHERE id=$1 FOR SHARE', [run.deviceId])
    const { rows: [repo] } = await client.query<Repository>('SELECT id,"userId","deviceId","repoPath","remoteUrl" FROM device_repos WHERE id=$1 FOR SHARE', [run.deviceRepoId])
    const { rows: [token] } = await client.query<DeviceToken>(`SELECT t.id,t."userId",t."boundWorkspaceId",t."boundDeviceId",t."revokedAt",t."revokedBy",t."expiresAt",
      EXISTS(SELECT 1 FROM device_credential_revocations d WHERE d."tokenId"=t.id) AS "explicitRevocation"
      FROM device_tokens t WHERE t.id=$1 FOR SHARE OF t`, [run.deviceTokenId])
    const { rows: [machine] } = await client.query<Machine>(`SELECT ${MACHINE_COLUMNS} FROM thread_machines WHERE "runId"=$1 FOR ${work ? 'UPDATE' : 'SHARE'}`, [run.id])
    const { rows: publications } = await client.query<{ remoteKey: string }>('SELECT "remoteKey" FROM run_publications WHERE "runId"=$1 AND "userId"=$2 FOR SHARE', [run.id, session.user.id])
    const now = Date.now()
    // The trusted daemon overwrites a model-supplied safePoint. This receipt
    // is still only a hint: the machine's exclusive lock proves actual exit.
    const observed = run.exitObservedAt ? Date.parse(run.exitObservedAt) : NaN
    const nativeExitedProof = run.safeExit && Number.isFinite(observed) && observed <= now
      && !!run.startedAt && observed >= run.startedAt.getTime() && (ENDED.has(run.status) || run.pauseReason === 'quota_exhausted')
    const executionCredentialRevoked = !!token?.revokedBy || !!token?.explicitRevocation
    const deviceTokenActive = !!token && !token.revokedAt && !executionCredentialRevoked && (!token.expiresAt || token.expiresAt.getTime() > now)
    // Normal parking revokes the execution credential. A completed task may
    // acquire a NEW owner review lease without reviving that credential or
    // starting an Agent. Removed devices, explicit Stop and active-run token
    // revocation are never covered by this retained-filesystem case.
    const parkedProvenance = !executionCredentialRevoked && ENDED.has(run.status) && nativeExitedProof && !!machine
      && ['paused', 'review_starting', 'review_active', 'review_resume_requested', 'review_resumed'].includes(machine.lifecycle?.phase ?? '')
    if (!device || !device.enabled || device.removedAt || !token || !deviceTokenActive && !parkedProvenance) throw new ReviewAuthorityError('review_machine_gone')
    if (device.ownerId !== session.user.id || token.userId !== session.user.id || token.boundDeviceId && token.boundDeviceId !== device.id) throw denied()
    if (device.kind !== 'cloud' && device.kind !== 'local') throw new ReviewAuthorityError('review_checkout_unavailable')
    if (!repo || repo.userId !== session.user.id || repo.deviceId !== device.id || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: device.kind === 'local' })) throw denied()
    if ([run.frozenKey, ...publications.map(p => p.remoteKey)].some(key => key && key !== repo.repoPath)
      || run.admissionDevice && run.admissionDevice !== device.id || run.admissionOwner && run.admissionOwner !== session.user.id
      || run.admissionTask && run.admissionTask !== taskId) throw denied()
    const scopes = [run.frozenWorkspace, run.admissionWorkspace, run.botWorkspace, run.bindingWorkspace, token.boundWorkspaceId, machine?.workspaceId]
    if (run.storedWorkspace !== workspaceId || scopes.some(scope => scope && scope !== workspaceId)
      || run.bindingOwner && run.bindingOwner !== session.user.id) throw denied()
    if (machine && (machine.ownerId !== session.user.id || machine.deviceId !== device.id || machine.issueId !== taskId || machine.repoId !== repo.id)) throw denied()
    if (device.kind === 'cloud' && (!run.machineAuthority || !machine || !machine.sandboxId || !['running', 'paused'].includes(machine.state))) throw new ReviewAuthorityError('review_machine_gone')
    if (run.stopRequestedAt || run.status === 'stopped' || run.status === 'cancelled'
      || ACTIVE.has(run.status) && (!run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= now)) throw new ReviewAuthorityError('review_machine_gone')
    if (!ACTIVE.has(run.status) && !ENDED.has(run.status)) throw new ReviewAuthorityError('review_checkout_unavailable')
    if (!run.worktreePath || !isAbsolute(run.worktreePath) || normalize(run.worktreePath) !== run.worktreePath || /[\0\r\n]/.test(run.worktreePath)) throw new ReviewAuthorityError('review_checkout_unavailable')
    let sponsoredPlacement: TaskReviewAuthority['sponsoredPlacement']
    if (run.taskProvider === 'cloudflare' || machine?.snapshotId === hostedSnapshot) {
      if (run.taskProvider !== 'cloudflare' || machine?.snapshotId !== hostedSnapshot ||
          !machine.sandboxId || !/^[a-f0-9]{64}$/.test(machine.sandboxId)) throw denied()
      try {
        sponsoredPlacement = await sponsoredReviewPlacement(client, {userId:session.user.id, workspaceId}, run.id)
      } catch { throw denied() }
      if (sponsoredPlacement.operationId !== machine.operationId || sponsoredPlacement.repositoryKey !== repo.repoPath) throw denied()
      const checkpoint = readReviewCheckpoint(machine.lifecycle?.sponsoredPreparedCheckpoint, machine.sandboxId)
      if (checkpoint) sponsoredPlacement = {...sponsoredPlacement, checkpoint}
    }
    const bindingId = createHash('sha256').update(JSON.stringify([run.id, workspaceId, run.userId, taskId, run.deviceId,
      repo.id, token.id, repo.repoPath, run.worktreePath, run.attempt, run.sessionId, machine?.sandboxId ?? null,
      machine?.epoch ?? null, machine?.operationId ?? null, ...(sponsoredPlacement ? ['cloudflare', sponsoredPlacement.repositoryKey] : [])])).digest('hex')
    if (expected.bindingId && expected.bindingId !== bindingId) throw new ReviewAuthorityError('review_binding_changed')
    const result: TaskReviewAuthority = { taskId, runId: run.id, userId: session.user.id, ownerId: run.userId, workspaceId,
      deviceId: device.id, repoId: repo.id, deviceTokenId: token.id, remoteKey: repo.repoPath, repoPath: repo.repoPath,
      worktreePath: run.worktreePath, machineKind: device.kind, sandboxId: machine?.sandboxId ?? null,
      machineEpoch: machine?.epoch ?? null, machineOperationId: machine?.operationId ?? null,
      machineStatus: machine?.state ?? 'running', runStatus: run.status, pauseReason: run.pauseReason,
      leaseExpiresAt: run.leaseExpiresAt?.toISOString() ?? null, nativeExitedProof, deviceTokenActive, bindingId, credential, credentialExpiresAt, ...(sponsoredPlacement ? {sponsoredPlacement} : {}) }
    // Only bounded database work belongs here (e.g. recording a lease).
    // Provider installation and other network IO happen before authorization.
    const value = work ? await work(result, client) : result
    await lockCredential(client, session, credential)
    await client.query('COMMIT'); appOpen = false
    await workspace.query('ROLLBACK'); workspaceOpen = false
    return value
  } finally {
    if (appOpen) await client?.query('ROLLBACK').catch(() => {})
    client?.release()
    if (workspaceOpen) await workspace.query('ROLLBACK').catch(() => {})
    workspace.release()
  }
}

function requestScope(request: Request, expected: ReviewAuthorityExpectation): ReviewAuthorityExpectation {
  // An explicit native workspace wins over the saved browser selection, as
  // elsewhere in the app. Neither can grant access; both only narrow it.
  const selected = request.headers.get('x-mikka-workspace-id')
    ?? request.headers.get('cookie')?.match(/(?:^|;\s*)mikka-workspace=([^;]*)/)?.[1]
  if (selected !== undefined && selected !== null) {
    if (!z.uuid().safeParse(selected).success || expected.workspaceId && expected.workspaceId !== selected) throw denied()
    return { ...expected, workspaceId: selected }
  }
  return expected
}

export async function taskReviewAuthority(request: Request, taskId: string, expected: ReviewAuthorityExpectation = {}) {
  const [{ getApiSession }, { pool }, { workspacePool }] = await Promise.all([import('../api-auth'), import('../db'), import('../workspace-db')])
  const session = await getApiSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session) throw new ReviewAuthorityError('review_auth_required')
  return resolveTaskReviewAuthority(pool, workspacePool, session, taskId, requestScope(request, expected))
}

/** Record a capability atomically with the last fresh authority check. */
export async function withTaskReviewAuthority<T>(request: Request, taskId: string,
  work: ReviewAuthorityWork<T>, expected: ReviewAuthorityExpectation = {}) {
  const [{ getApiSession }, { pool }, { workspacePool }] = await Promise.all([import('../api-auth'), import('../db'), import('../workspace-db')])
  const session = await getApiSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session) throw new ReviewAuthorityError('review_auth_required')
  return resolveTaskReviewAuthority(pool, workspacePool, session, taskId, requestScope(request, expected), work)
}
