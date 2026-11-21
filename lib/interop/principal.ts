import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { requireTaskWorkspace } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import type { EnterprisePrincipal } from '@/lib/enterprise/principal'
import type { ResourceAction, ResourceKind } from '@/lib/resource-access/contract'
import { InteropError } from './errors'

/**
 * Who reads or sends across Agents and Bots (decision 2026-11-19-2200).
 *
 * Every principal is pinned to one Workspace. That tenant goes to
 * `mikka_resource_acl_allowed`, which refuses a resource of any other tenant,
 * so no grant reaches across tenants. `bot` and `run` act with their owner's
 * identity *and* may hold their own explicit grants; `service` has no owner and
 * only its grants.
 */
export type InteropPrincipal =
  | { kind: 'account'; userId: string; workspaceId: string; enterprise?: EnterprisePrincipal }
  | { kind: 'bot'; botId: string; ownerId: string; workspaceId: string }
  | { kind: 'run'; runId: string; ownerId: string; workspaceId: string }
  | { kind: 'service'; serviceId: string; workspaceId: string }

export type InteropReference = { kind: ResourceKind; id: string }

const uuid = z.uuid()

/** The owner whose identity a tool executes with; a service has none. */
export function principalOwner(principal: InteropPrincipal): string | null {
  switch (principal.kind) {
    case 'account': return principal.userId
    case 'bot': case 'run': return principal.ownerId
    case 'service': return null
  }
}

/** The principal's own ACL subject, beside its owner's. */
export function principalSubject(principal: InteropPrincipal): { kind: 'bot' | 'run' | 'service'; id: string } | null {
  switch (principal.kind) {
    case 'bot': return { kind: 'bot', id: principal.botId }
    case 'run': return { kind: 'run', id: principal.runId }
    case 'service': return { kind: 'service', id: principal.serviceId }
    case 'account': return null
  }
}

/** A reader for the existing task-workspace admission, pinned to the principal's tenant. */
export function principalReader(principal: InteropPrincipal): { id: string; [tokenWorkspace]: string } | null {
  const owner = principalOwner(principal)
  return owner ? { id: owner, [tokenWorkspace]: principal.workspaceId } : null
}

/**
 * The owner must still be an active member of the tenant on every call; a
 * removed member's Bot or run reads nothing. A service key was proven valid
 * for its team Workspace when it authenticated.
 */
export async function admitPrincipal(principal: InteropPrincipal): Promise<void> {
  const reader = principalReader(principal)
  if (!reader) return
  try { await requireTaskWorkspace(reader, principal.workspaceId) }
  catch (error) {
    if (error instanceof ActionFailureError) throw new InteropError('interop_not_found', { cause: error })
    throw error
  }
}

/**
 * Owner OR own-subject grant, both under the principal's tenant. Call after
 * `admitPrincipal`. Never throws for a denial: callers that must not disclose
 * existence turn `false` into `interop_not_found`.
 */
export async function interopAllowed(principal: InteropPrincipal, reference: InteropReference, action: ResourceAction,
  executor: { query: typeof pool.query } = pool): Promise<boolean> {
  if (!uuid.safeParse(reference.id).success) return false
  const owner = principalOwner(principal)
  const subject = principalSubject(principal)
  const { rows: [row] } = await executor.query<{ allowed: boolean }>(`SELECT
      ($1::text IS NOT NULL AND mikka_resource_acl_allowed('account',$1,$3::uuid,$4,$5::uuid,$6))
      OR ($2::text IS NOT NULL AND mikka_resource_acl_allowed($7,$2,$3::uuid,$4,$5::uuid,$6)) AS allowed`,
  [owner, subject?.id ?? null, principal.workspaceId, reference.kind, reference.id, action, subject?.kind ?? 'account'])
  return row?.allowed === true
}

/** `[owner, subjectId, subjectKind]` for `aclPredicate`, in that order. */
export function aclParams(principal: InteropPrincipal): [string | null, string | null, string] {
  const subject = principalSubject(principal)
  return [principalOwner(principal), subject?.id ?? null, subject?.kind ?? 'account']
}

/**
 * The same decision as `interopAllowed` as a list predicate. `base` is the
 * placeholder number of the first of `aclParams`; kind and action are typed
 * literals, never caller text.
 */
export function aclPredicate(base: number, tenant: string, kind: ResourceKind, idExpression: string, action: ResourceAction): string {
  const owner = `$${base}`, subject = `$${base + 1}`, subjectKind = `$${base + 2}`
  return `((${owner}::text IS NOT NULL AND mikka_resource_acl_allowed('account',${owner},${tenant},'${kind}',${idExpression},'${action}'))
    OR (${subject}::text IS NOT NULL AND mikka_resource_acl_allowed(${subjectKind},${subject},${tenant},'${kind}',${idExpression},'${action}')))`
}

export async function requireInterop(principal: InteropPrincipal, reference: InteropReference, action: ResourceAction): Promise<void> {
  if (!await interopAllowed(principal, reference, action)) throw new InteropError('interop_not_found')
}

/** A Bot acting in its own tenant, with its owner's identity. */
export async function botPrincipal(ownerId: string, botId: string): Promise<InteropPrincipal> {
  if (!uuid.safeParse(botId).success) throw new InteropError('interop_not_found')
  const { rows: [bot] } = await pool.query<{ workspaceId: string | null }>(
    'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL', [botId, ownerId])
  if (!bot?.workspaceId) throw new InteropError('interop_not_found')
  const principal: InteropPrincipal = { kind: 'bot', botId, ownerId, workspaceId: bot.workspaceId }
  await admitPrincipal(principal)
  return principal
}

/** An Agent inside a live run (already proven by its run token). */
export async function runPrincipal(ownerId: string, runId: string): Promise<InteropPrincipal> {
  if (!uuid.safeParse(runId).success) throw new InteropError('interop_not_found')
  const { rows: [run] } = await pool.query<{ workspaceId: string | null }>(
    'SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, ownerId])
  if (!run?.workspaceId) throw new InteropError('interop_not_found')
  const principal: InteropPrincipal = { kind: 'run', runId, ownerId, workspaceId: run.workspaceId }
  await admitPrincipal(principal)
  return principal
}

/** How a message from this principal is attributed to its recipient. */
export function principalSender(principal: InteropPrincipal): { kind: InteropPrincipal['kind']; id: string } {
  switch (principal.kind) {
    case 'account': return { kind: 'account', id: principal.userId }
    case 'bot': return { kind: 'bot', id: principal.botId }
    case 'run': return { kind: 'run', id: principal.runId }
    case 'service': return { kind: 'service', id: principal.serviceId }
  }
}
