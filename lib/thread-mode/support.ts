import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { THREAD_MODES, threadModeSupport, type ThreadMode } from '@mikka/protocol/thread-mode'
import { threadModeLocked } from './store'

/** What the server can promise about one mode on this run's Agent and device. */
export type ThreadModeSupportState = { state: 'enforced' | 'unsupported'; reason?: 'harness' | 'daemon' }
export type ThreadModeSupport = Record<ThreadMode, ThreadModeSupportState>

/** `devices.harnesses` entries carry the modes a live daemon can enforce. */
function reportedModes(value: unknown, harness: string): string[] | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (!item || typeof item !== 'object' || (item as { harness?: unknown }).harness !== harness) continue
    const modes = (item as { threadModes?: unknown }).threadModes
    return Array.isArray(modes) ? modes.filter((mode): mode is string => typeof mode === 'string') : null
  }
  return null
}

/**
 * The mode support a picker must show, never inferred in the browser: the
 * harness matrix first, then the device's own report for a local daemon. A
 * cloud sandbox has no device row to ask; its image carries the daemon.
 * Execute is the behavior a run had before modes existed, so it is always
 * offered; plan and ask must be reported as enforced.
 */
export async function readThreadModeSupport(query: Pick<Pool | PoolClient, 'query'>, userId: string, runId: string): Promise<{ locked: boolean; support: ThreadModeSupport }> {
  const { rows: [run] } = await query.query<{ issueId: string | null; harness: string | null; deviceKind: string | null; harnesses: unknown }>(
    `SELECT r."issueId", a.harness, d.kind AS "deviceKind", d.harnesses
       FROM agent_runs r
       LEFT JOIN agents a ON a.id = r."agentId" AND a."userId" = r."userId"
       LEFT JOIN devices d ON d.id = a."deviceId" AND d."ownerId" = r."userId"
      WHERE r.id=$1 AND r."userId"=$2`, [runId, userId])
  if (!run?.issueId) throw new Error('threadModeUnavailable')
  const locked = await threadModeLocked(query, userId, run.issueId)
  const support = {} as ThreadModeSupport
  for (const mode of THREAD_MODES) {
    if (mode === 'execute') { support[mode] = { state: 'enforced' }; continue }
    if (threadModeSupport(run.harness ?? '', mode) !== 'enforced') {
      support[mode] = { state: 'unsupported', reason: 'harness' }
      continue
    }
    // A local daemon names the modes it can enforce; one that reports nothing
    // predates the gate. A cloud run's daemon comes from its image instead.
    if (run.deviceKind && run.deviceKind !== 'cloud') {
      const modes = reportedModes(run.harnesses, run.harness ?? '')
      if (!modes?.includes(mode)) { support[mode] = { state: 'unsupported', reason: 'daemon' }; continue }
    }
    support[mode] = { state: 'enforced' }
  }
  return { locked, support }
}
