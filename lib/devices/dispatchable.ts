export type DeviceOption = { id: string; name: string; online: boolean }
type Query = (sql: string, values: unknown[]) => Promise<{ rows: DeviceOption[] }>

/** A device counts as online when its daemon checked in inside the presence window. */
export const ONLINE_WINDOW = "interval '2 minutes'"

/**
 * The machines a new thread may be pinned to: only this person's own live, dispatchable
 * devices. Names and presence only — never hostnames, tokens or run history. A thread that
 * names a device the caller cannot reach is refused by lib/group-conversations-store.ts, so
 * this list is a convenience, not the authorization.
 *
 * Kept free of the pool and the session so the owner scope and the SQL can be checked
 * without a database or a request.
 */
export async function listDispatchableDevices(query: Query, ownerId: string): Promise<DeviceOption[]> {
  const { rows } = await query(
    `SELECT id, name, ("lastSeenAt" IS NOT NULL AND "lastSeenAt" > now() - ${ONLINE_WINDOW}) AS online
       FROM devices
      WHERE "ownerId"=$1 AND "removedAt" IS NULL AND enabled AND kind='local'
      ORDER BY online DESC, name ASC
      LIMIT 50`, [ownerId])
  return rows
}
