import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { QuotaStore, type QuotaRequest } from './store'
import { QuotaError, quotaFailure } from './errors'

export const tenantQuotas = new QuotaStore(pool, async (ownerId, workspaceId) => {
  const [member] = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, ownerId), eq(workspaceMembers.status, 'active'))).limit(1)
  return Boolean(member)
})

export async function beginQuota(input: QuotaRequest) {
  const reservation = await tenantQuotas.reserve(input)
  return tenantQuotas.activate(input.ownerId, reservation.id)
}

export { quotaFailure } from './errors'

export async function withTenantQuota<T>(ownerId: string, resource: string, binding: unknown, action: () => Promise<T>, key: string = randomUUID()): Promise<T> {
  const reservation = await beginQuota({ ownerId, resource, binding, key })
  let value: T
  try { value = await action() }
  catch (error) {
    const failure = quotaFailure(error)
    await tenantQuotas.finish(ownerId, reservation.id, failure.outcome, undefined, failure.retryAfter)
    throw error
  }
  await tenantQuotas.finish(ownerId, reservation.id, 'settled')
  return value
}

/** Safe for tools: callers see a stable actionable code, never raw SDK messages. */
export function quotaToolError(error: unknown) {
  if (!(error instanceof QuotaError)) throw error
  return { error: error.code, retryAfter: error.retryAfter }
}
