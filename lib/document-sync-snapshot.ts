export type SyncSnapshot = { ready: boolean; pending: boolean; error: boolean; syncing: boolean }

const KEYS = ['ready', 'pending', 'error', 'syncing'] as const

/** Returns the next snapshot, or null when the patch would not change what React renders. */
export function nextSyncSnapshot(current: SyncSnapshot, patch: Partial<SyncSnapshot>): SyncSnapshot | null {
  let changed = false
  const next: SyncSnapshot = { ...current }
  for (const key of KEYS) {
    const value = patch[key]
    if (value === undefined || value === current[key]) continue
    next[key] = value
    changed = true
  }
  return changed ? next : null
}
