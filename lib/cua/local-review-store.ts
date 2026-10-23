import 'server-only'
import { and, eq, gt, inArray, isNull, lt, notInArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, devices, localComputerReviews as reviews } from '@/lib/db/schema'
import { checkedLocalReview } from './local-review'
import type { LocalComputerRequest } from '@mikka/protocol/computer'
const live = ['running', 'preparing', 'waiting_input', 'finishing'] as const
const fresh = () => new Date(Date.now() - 10000)

export async function syncLocalReviews(deviceId: string, userId: string, snapshots: LocalComputerRequest[]) {
  const now = new Date()
  const rows = snapshots.map(row => checkedLocalReview(row, now.getTime()))
  return db.transaction(async tx => {
    // Server authentication must own BOTH the device and each live run. A model/run token cannot post here.
    const runs = rows.length ? await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(
      eq(agentRuns.deviceId, deviceId), eq(agentRuns.userId, userId),
      isNull(agentRuns.stopRequestedAt), inArray(agentRuns.status, [...live]), inArray(agentRuns.id, rows.map(r => r.runId)),
    )) : []
    const allowed = new Set(runs.map(r => r.id))
    if (rows.some(row => !allowed.has(row.runId))) throw new Error('Run unavailable')
    await tx.delete(reviews).where(and(eq(reviews.userId, userId), lt(reviews.expiresAt, now)))
    await tx.delete(reviews).where(and(eq(reviews.deviceId, deviceId), eq(reviews.userId, userId),
      ...(rows.length ? [notInArray(reviews.id, rows.map(r => r.id))] : [])))
    for (const row of rows) {
      await tx.insert(reviews).values({ ...row, deviceId, userId, expiresAt: new Date(row.expiresAt), seenAt: now }).onConflictDoNothing()
      // A duplicate id with a changed digest never overwrites the reviewed operation or decision.
      await tx.update(reviews).set({ seenAt: now }).where(and(eq(reviews.id, row.id), eq(reviews.deviceId, deviceId), eq(reviews.userId, userId), eq(reviews.digest, row.digest)))
    }
    if (!rows.length) return []
    const pending = await tx.select({ id: reviews.id, digest: reviews.digest, approve: reviews.decision }).from(reviews).where(and(
      eq(reviews.deviceId, deviceId), eq(reviews.userId, userId), inArray(reviews.id, rows.map(r => r.id)), gt(reviews.expiresAt, now), gt(reviews.seenAt, fresh()),
    )).limit(20)
    return pending.flatMap(row => row.approve === null ? [] : [{ ...row, approve: row.approve }])
  })
}
export async function pendingLocalReviews(userId: string) {
  await db.delete(reviews).where(and(eq(reviews.userId, userId), lt(reviews.expiresAt, new Date())))
  return db.select({ id: reviews.id, runId: reviews.runId, digest: reviews.digest, target: reviews.target,
    call: reviews.call, expiresAt: reviews.expiresAt, device: devices.name }).from(reviews)
    .innerJoin(devices, eq(devices.id, reviews.deviceId)).innerJoin(agentRuns, eq(agentRuns.id, reviews.runId))
    .where(and(eq(reviews.userId, userId), eq(devices.ownerId, userId), eq(agentRuns.userId, userId),
      isNull(agentRuns.stopRequestedAt), inArray(agentRuns.status, [...live]), isNull(reviews.decision),
      gt(reviews.expiresAt, new Date()), gt(reviews.seenAt, fresh()))).limit(20)
}
export async function decideLocalReview(userId: string, id: string, digest: string, approve: boolean) {
  // One atomic decision: approval is queueing ONLY, not confirmation the device executed anything.
  const pending = await pendingLocalReviews(userId)
  if (!pending.some(row => row.id === id && row.digest === digest)) return false
  const rows = await db.update(reviews).set({ decision: approve }).where(and(eq(reviews.id, id), eq(reviews.userId, userId),
    eq(reviews.digest, digest), isNull(reviews.decision), gt(reviews.expiresAt, new Date()), gt(reviews.seenAt, fresh()))).returning({ id: reviews.id })
  return rows.length === 1
}
