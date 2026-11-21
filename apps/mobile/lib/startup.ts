/** How long launch waits for the update server or Mikka before letting the person in anyway. */
export const CHECK_MS = 5_000
/** How long launch waits for a found update to download; past it the app opens and the update waits for 重启以更新. */
export const DOWNLOAD_MS = 20_000

let upgradeServer: string | null = null
const upgradeListeners = new Set<(server: string) => void>()

/** A server's explicit 426 wakes the existing update screen without polling
 * or forcing an application reload. The caller keeps its original cause. */
export function requireMobileUpdate(server: string) {
  upgradeServer = server
  for (const listener of upgradeListeners) listener(server)
}

export function onMobileUpdateRequired(listener: (server: string) => void) {
  upgradeListeners.add(listener)
  if (upgradeServer) listener(upgradeServer)
  return () => { upgradeListeners.delete(listener) }
}

/** `promise`'s value, or `fallback` once `ms` pass or it fails: launch never waits longer, and never locks the person out. */
export async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms) })
  try {
    return await Promise.race([promise.catch(() => fallback), late])
  } finally {
    clearTimeout(timer)
  }
}

/** True when this native build is older than the oldest Mikka accepts; an unknown build or minimum lets the person in. */
export function buildTooOld(nativeBuild: string | null | undefined, minBuild: unknown): boolean {
  const build = Number.parseInt(nativeBuild ?? '', 10)
  return Number.isFinite(build) && typeof minBuild === 'number' && Number.isFinite(minBuild) && build < minBuild
}
