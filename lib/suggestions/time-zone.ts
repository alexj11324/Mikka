import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userTimeZones, type TimeZoneSource } from '@/lib/db/schema'

// The 时区 setting (docs/settings-backend/prefs.md). 自动 keeps today's
// behaviour: the browser's zone replaces any earlier one and the IP guess fills
// a gap (lib/suggestions/store.ts recordTimeZone). A zone the person picks is
// 'manual' and stays until they pick another or go back to 自动; reports then
// only update detectedTimeZone.

export interface TimeZoneSetting {
  /** The zone the briefings use; null until one is known. */
  timeZone: string | null
  source: TimeZoneSource
  /** What the browser or IP last reported; null when nothing has. */
  detected: string | null
}

let canonicalZones: Set<string> | null = null

/** True for a canonical IANA name as Intl knows it (e.g. Asia/Shanghai, America/New_York) or UTC. */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false
  canonicalZones ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])
  return canonicalZones.has(value)
}

export async function readTimeZoneSetting(userId: string): Promise<TimeZoneSetting> {
  const [row] = await db.select().from(userTimeZones).where(eq(userTimeZones.userId, userId)).limit(1)
  if (!row) return { timeZone: null, source: 'auto', detected: null }
  return { timeZone: row.timeZone, source: row.source, detected: row.detectedTimeZone ?? (row.source === 'auto' ? row.timeZone : null) }
}

/** The zone the person picked, or null under 自动. */
export async function manualTimeZone(userId: string): Promise<string | null> {
  const [row] = await db.select({ timeZone: userTimeZones.timeZone, source: userTimeZones.source }).from(userTimeZones).where(eq(userTimeZones.userId, userId)).limit(1)
  return row?.source === 'manual' ? row.timeZone : null
}

/**
 * Picks a zone (`manual`) or goes back to 自动. 自动 takes the last detected
 * zone; with none detected yet the row is removed, as for someone who never
 * reported one. The caller validates the name (isIanaTimeZone).
 */
export async function writeTimeZoneSetting(userId: string, choice: string | 'auto'): Promise<TimeZoneSetting> {
  const now = new Date()
  if (choice === 'auto') {
    const current = await readTimeZoneSetting(userId)
    if (!current.detected) await db.delete(userTimeZones).where(eq(userTimeZones.userId, userId))
    else await db.update(userTimeZones).set({ timeZone: current.detected, source: 'auto', updatedAt: now }).where(eq(userTimeZones.userId, userId))
    return readTimeZoneSetting(userId)
  }
  await db.insert(userTimeZones).values({ userId, timeZone: choice, source: 'manual', updatedAt: now })
    .onConflictDoUpdate({ target: userTimeZones.userId, set: { timeZone: choice, source: 'manual', updatedAt: now } })
  return readTimeZoneSetting(userId)
}
