import 'server-only'
import type { Pool } from 'pg'
import { isDeviceOnline } from '@mikka/protocol/device'
import type { HarnessInfo } from '@mikka/protocol/harness'

// Where a dispatch runs when the person named the place (decision
// 2026-11-01-1330-one-thread-per-task, device targets): one of their own
// computers, or the cloud. The server checks the computer every time; a
// computer that is not theirs, removed or unknown is refused, and one that
// is offline or switched off gets the 没有可用的电脑 card at once, with nothing
// queued and no other computer picked instead.

/** What the person asked for: one of their computers by id, or the cloud. */
export type DispatchTarget = 'cloud' | { deviceId: string }

/** Where a run actually runs, as the dispatch result reports it. */
export type RunPlacement = { kind: 'device'; deviceId: string; name: string } | { kind: 'cloud' }

type Query = Pick<Pool, 'query'>

/**
 * The person's own computer as a dispatch target: its Agent for the first
 * installed harness it has one for. `notFound`: not theirs, removed, or not a
 * computer a person picks (a cloud thread machine). `unavailable`: theirs, but
 * offline or switched off.
 */
export async function targetDevice(query: Query, userId: string, deviceId: string): Promise<
  { deviceId: string; name: string; agentId: string; harness: string; model?: string } | { error: 'notFound' } | { error: 'unavailable' }> {
  const { rows: [device] } = await query.query<{ id: string; name: string; enabled: boolean; lastSeenAt: Date | null; harnesses: HarnessInfo[] | null }>(
    `SELECT id,name,enabled,"lastSeenAt",harnesses FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL`, [deviceId, userId])
  if (!device) return { error: 'notFound' }
  if (!device.enabled || !isDeviceOnline(device.lastSeenAt)) return { error: 'unavailable' }
  for (const info of (device.harnesses ?? []).filter(item => item.installed)) {
    const { rows: [agent] } = await query.query<{ id: string }>('SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 ORDER BY "createdAt",id LIMIT 1', [userId, device.id, info.harness])
    if (agent) return { deviceId: device.id, name: device.name, agentId: agent.id, harness: info.harness, ...(info.defaultModelSlot ?? info.models?.[0] ? { model: info.defaultModelSlot ?? info.models?.[0] } : {}) }
  }
  return { error: 'unavailable' }
}

/** Where the run is: the person's computer by name, or the cloud (a Bot computer or a thread machine). */
export async function runPlacement(query: Query, userId: string, runId: string): Promise<RunPlacement | null> {
  const { rows: [row] } = await query.query<{ deviceId: string | null; name: string | null; kind: string | null; cloud: boolean }>(
    `SELECT r."deviceId",d.name,d.kind,EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id) AS cloud
     FROM agent_runs r LEFT JOIN devices d ON d.id=r."deviceId" WHERE r.id=$1 AND r."userId"=$2`, [runId, userId])
  if (!row) return null
  if (row.cloud || row.kind === 'cloud') return { kind: 'cloud' }
  return row.deviceId && row.name ? { kind: 'device', deviceId: row.deviceId, name: row.name } : null
}

/** Whether `target` names another place than where `placement` is; no target never moves a thread. */
export function movesThread(target: DispatchTarget | undefined, placement: RunPlacement | null): boolean {
  if (!target || !placement) return false
  return target === 'cloud' ? placement.kind !== 'cloud' : placement.kind !== 'device' || placement.deviceId !== target.deviceId
}
