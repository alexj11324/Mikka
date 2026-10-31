import { useEffect } from 'react'
import { AppState } from 'react-native'
import Constants from 'expo-constants'
import * as Updates from 'expo-updates'

let fetching = false

/** Checks for an OTA update and downloads it, at most one at a time; failures wait for the next try. */
async function prefetch() {
  if (fetching) return
  fetching = true
  try {
    if ((await Updates.checkForUpdateAsync()).isAvailable) await Updates.fetchUpdateAsync()
  } catch {
    // Offline or the update server is down: the next launch or foreground tries again.
  } finally {
    fetching = false
  }
}

/**
 * True once a newer JS update has been downloaded (decision
 * 2026-10-31-2010-ota-updates). Checks on launch and whenever the app comes
 * back to the foreground; the drawer then offers 重启以更新.
 */
export function useUpdateReady(): boolean {
  const { isUpdatePending } = Updates.useUpdates()
  useEffect(() => {
    if (!Updates.isEnabled) return
    void prefetch()
    const sub = AppState.addEventListener('change', state => { if (state === 'active') void prefetch() })
    return () => sub.remove()
  }, [])
  return Updates.isEnabled && isUpdatePending
}

export const restartToUpdate = () => { void Updates.reloadAsync() }

/**
 * 设置 › 版本: the app version and native build, and when the running update
 * was published if it is not the one built in, e.g. 「1.0.0 (6) · 10-31 22:51」.
 */
export function versionLabel() {
  const build = Constants.platform?.ios?.buildNumber
  const base = [Constants.expoConfig?.version ?? '', build ? `(${build})` : ''].filter(Boolean).join(' ')
  if (!Updates.isEnabled || Updates.isEmbeddedLaunch || !Updates.createdAt) return base
  const at = Updates.createdAt
  const two = (n: number) => String(n).padStart(2, '0')
  return `${base} · ${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}
