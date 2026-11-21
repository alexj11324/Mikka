import 'server-only'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool } from 'pg'
import {
  CodingWorkspaceError, WORKSPACE_REQUEST_TTL_MS, workspaceReadCommand, workspaceReadResult, workspaceRequestPathsAllowed,
  type WorkspaceReadCommand, type WorkspaceReadRequest, type WorkspaceReadResult, type WorkspaceReadReceipt, type RunWorktreeIdentity,
} from '@mikka/protocol/coding-workspace'
import { DEVICE_WORK_CHANNEL, notifyChannel, subscribeShared } from '../db/listen'
import { wakeDeviceWorkNow } from '../device-gateway-notify'
import { secretMaskerFor } from '../secrets/runtime'
import { maskDeep } from '../secrets/mask'
import { resolveRunWorktree, type WorkspaceActor, type WorkspaceQuery } from './identity'
import { validateWorkspaceReceipt } from './receipt'
import { retainGitUndo } from './git/undo'

const receiptPolicy = Symbol('workspace-receipt-mask-policy')
const receiptIdentity = Symbol('workspace-receipt-identity')
/** Private evidence only; it never appears in a device or public DTO. */
export function workspaceResultMaskPolicy(result: object): string | undefined {
  return (result as { [receiptPolicy]?: string })[receiptPolicy]
}

export function workspaceResultIdentity(result: object): RunWorktreeIdentity | undefined {
  return (result as { [receiptIdentity]?: RunWorktreeIdentity })[receiptIdentity]
}

export function copyWorkspaceResultMaskPolicy<T extends object>(source: object, target: T): T {
  Object.defineProperty(target, receiptPolicy, { value: workspaceResultMaskPolicy(source) })
  Object.defineProperty(target, receiptIdentity, { value: workspaceResultIdentity(source) })
  return target
}

/** Call after asynchronous authorization and immediately before exposing or
 * committing source fragments. Partial text cannot prove safety against a
 * newly registered secret that spans multiple selected ranges. */
export async function assertWorkspaceResultMaskPolicy(result: object, actor: WorkspaceActor): Promise<void> {
  const policy = workspaceResultMaskPolicy(result)
  const mask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })
  if (!policy || policy !== mask.sourcePolicy) throw new CodingWorkspaceError('workspace_path_unavailable')
}

export async function requestWorkspaceRead(database: Pool, membership: WorkspaceQuery, actor: WorkspaceActor,
  runId: string, repoId: string, request: WorkspaceReadRequest, signal?: AbortSignal,
  options: { ttlMs?: number } = {}): Promise<WorkspaceReadResult> {
  const binding = await resolveRunWorktree(database, membership, actor, runId, repoId)
  if (!workspaceRequestPathsAllowed(request)) throw new CodingWorkspaceError('workspace_path_unavailable')
  const requestMask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })
  if (!isDeepStrictEqual(maskDeep(request, requestMask), request)) throw new CodingWorkspaceError('workspace_path_unavailable')
  const ttl = Math.min(Math.max(options.ttlMs ?? WORKSPACE_REQUEST_TTL_MS, 1_000), 60_000)
  const id = randomUUID(), expiresAt = new Date(Date.now() + ttl)
  const subscription = await subscribeShared(database, DEVICE_WORK_CHANNEL, [`workspace:${id}`], signal)
  // No timer-based SQL retry when LISTEN is unavailable.
  if (!subscription) throw new CodingWorkspaceError('workspace_machine_unavailable')
  try {
    // A per-owner transaction serializes the quota check; unrelated tenants do
    // not contend. Old crash residues carry no valid capability and are removed.
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`coding-workspace:${actor.userId}`])
      await client.query('DELETE FROM coding_workspace_requests WHERE "ownerId"=$1 AND "expiresAt"<clock_timestamp()', [actor.userId])
      const active = await client.query('SELECT count(*)::int AS n FROM coding_workspace_requests WHERE "ownerId"=$1', [actor.userId])
      if (active.rows[0].n >= 8) throw new CodingWorkspaceError('workspace_limit_exceeded')
      await client.query(`INSERT INTO coding_workspace_requests (id,"ownerId","workspaceId","runId","repoId","deviceId","tokenId",identity,request,"expiresAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, actor.userId, actor.workspaceId, runId, repoId, binding.identity.deviceId, binding.tokenId, binding.identity, request, expiresAt])
      await notifyChannel(client, DEVICE_WORK_CHANNEL, [binding.identity.deviceId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    await wakeDeviceWorkNow(binding.identity.deviceId)
    for (;;) {
      subscription.reset()
      const { rows: [row] } = await database.query<{ result: unknown; maskPolicy: string | null }>('SELECT result,"maskPolicy" FROM coding_workspace_requests WHERE id=$1 AND "ownerId"=$2 AND "expiresAt">clock_timestamp()', [id, actor.userId])
      if (row?.result) {
        const fresh = await resolveRunWorktree(database, membership, actor, runId, repoId)
        if (fresh.identity.bindingId !== binding.identity.bindingId) throw new CodingWorkspaceError('workspace_version_conflict')
        const result = workspaceReadResult.parse(row.result)
        if (result.ok) {
          Object.defineProperty(result, receiptPolicy, { value: row.maskPolicy ?? undefined })
          // Public Git write DTOs are server-built and carry no identity.
          if ('identity' in result) Object.defineProperty(result, receiptIdentity, { value: result.identity })
          await assertWorkspaceResultMaskPolicy(result, actor)
        }
        return result
      }
      if (!row || signal?.aborted || subscription.lost || Date.now() >= expiresAt.getTime()) throw new CodingWorkspaceError('workspace_machine_unavailable')
      const wake = await subscription.next(expiresAt.getTime() - Date.now(), signal)
      if (wake !== 'notified') throw new CodingWorkspaceError('workspace_machine_unavailable')
    }
  } finally {
    subscription.close()
    await database.query('DELETE FROM coding_workspace_requests WHERE id=$1 AND "ownerId"=$2', [id, actor.userId])
  }
}

/** Called only inside withDeviceRoute, so its queries retain the credential fence. */
export async function pendingWorkspaceReads(database: WorkspaceQuery, membership: WorkspaceQuery,
  caller: { userId: string; tokenId: string }, deviceId: string, skip: readonly string[] = [],
  capabilities: { diff?: boolean; git?: boolean } = {}): Promise<WorkspaceReadCommand[]> {
  const { rows } = await database.query<{ id: string; identity: WorkspaceReadCommand['identity']; request: WorkspaceReadRequest; expiresAt: Date }>(
    `SELECT id,identity,request,"expiresAt" FROM coding_workspace_requests WHERE "deviceId"=$1 AND "ownerId"=$2 AND "tokenId"=$3
      AND result IS NULL AND "expiresAt">clock_timestamp() AND NOT(id=ANY($4::uuid[]))
      AND ($5::boolean OR request->>'kind' NOT IN ('diff_snapshot','diff_file'))
      AND ($6::boolean OR request->>'kind' NOT IN ('git_status','git_history','git_revert_preview','git_revert_apply',
        'git_undo','git_checkpoint_preview','git_checkpoint_restore'))
      ORDER BY "createdAt" LIMIT 4`, [deviceId, caller.userId, caller.tokenId, skip, capabilities.diff === true, capabilities.git === true])
  const result: WorkspaceReadCommand[] = []
  for (const row of rows) {
    try {
      const current = await resolveRunWorktree(database, membership, { userId: caller.userId, workspaceId: row.identity.workspaceId }, row.identity.runId, row.identity.repoId)
      if (current.identity.bindingId === row.identity.bindingId) result.push(workspaceReadCommand.parse({ ...row, expiresAt: row.expiresAt.toISOString() }))
    } catch (error) { if (!(error instanceof CodingWorkspaceError)) throw error }
  }
  return result
}

export async function finishWorkspaceRead(database: WorkspaceQuery, membership: WorkspaceQuery,
  caller: { userId: string; tokenId: string }, deviceId: string, id: string, receipt: WorkspaceReadReceipt): Promise<boolean> {
  const { rows: [row] } = await database.query<{ identity: WorkspaceReadCommand['identity']; request: WorkspaceReadRequest }>(
    `SELECT identity,request FROM coding_workspace_requests WHERE id=$1 AND "ownerId"=$2 AND "deviceId"=$3 AND "tokenId"=$4 AND "expiresAt">clock_timestamp()`,
    [id, caller.userId, deviceId, caller.tokenId])
  if (!row) return false
  const actor = { userId: caller.userId, workspaceId: row.identity.workspaceId }
  const current = await resolveRunWorktree(database, membership, actor, row.identity.runId, row.identity.repoId)
  if (current.identity.bindingId !== row.identity.bindingId) return false
  const mask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })
  const response = validateWorkspaceReceipt(row.request, row.identity, receipt, mask)
  if (!response) return false
  // Write receipts carry a masked Undo capture outside the public result: the
  // operation row keeps it for the retention window, never the request row.
  if (row.request.kind === 'git_revert_apply' || row.request.kind === 'git_checkpoint_restore')
    await retainGitUndo(database, row.request, receipt, mask, actor.userId)
  const saved = await database.query(`UPDATE coding_workspace_requests SET result=$5,"maskPolicy"=$6 WHERE id=$1 AND "ownerId"=$2 AND "deviceId"=$3 AND "tokenId"=$4
    AND result IS NULL AND "expiresAt">clock_timestamp() RETURNING id`, [id, caller.userId, deviceId, caller.tokenId, response, mask.sourcePolicy ?? null])
  if (saved.rowCount) {
    await notifyChannel(database, DEVICE_WORK_CHANNEL, [`workspace:${id}`])
    // A push can coalesce a burst larger than one four-command page. Receipt
    // completion is the next work event, so drain any remainder without an
    // idle timer or waiting for an unrelated heartbeat.
    const pending = await database.query(`SELECT 1 FROM coding_workspace_requests WHERE "deviceId"=$1 AND "ownerId"=$2
      AND "tokenId"=$3 AND result IS NULL AND "expiresAt">clock_timestamp() LIMIT 1`, [deviceId, caller.userId, caller.tokenId])
    if (pending.rowCount) {
      await notifyChannel(database, DEVICE_WORK_CHANNEL, [deviceId])
      await wakeDeviceWorkNow(deviceId)
    }
  }
  return Boolean(saved.rowCount)
}
