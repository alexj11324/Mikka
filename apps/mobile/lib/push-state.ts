import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'

/**
 * Whether the Coordinator's pushes can reach this phone (set by lib/push.ts):
 * - `unknown`: not checked yet;
 * - `unsupported`: Expo web or a simulator, which get no pushes;
 * - `undetermined`: iOS has not asked yet (the app asks after the first proactive message, or from 通知);
 * - `denied`: the person said no in iOS;
 * - `failed`: allowed, but the token could not be made or saved (no EAS project id, no network, a server error);
 * - `registered`: the server has this phone's token.
 * Kept apart from lib/push.ts so screens can read it without loading expo-notifications on web.
 */
export type PushState = 'unknown' | 'unsupported' | 'undetermined' | 'denied' | 'failed' | 'registered'

let state: PushState = Platform.OS === 'web' ? 'unsupported' : 'unknown'
const listeners = new Set<() => void>()

export const pushState = () => state

export function setPushState(next: PushState) {
  if (next === state) return
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePushState(): PushState {
  return useSyncExternalStore(subscribe, pushState, pushState)
}

/** Pushes cannot arrive: the 「推送无法送达」 row shows (mobile.md Settings, Comma iOS). */
export const pushUndeliverable = (value: PushState) => value === 'denied' || value === 'failed'

/** Shows iOS's prompt if it has not been shown, then registers; a no-op on web. */
export async function askForPush(): Promise<PushState> {
  if (Platform.OS === 'web') return state
  return (await import('@/lib/push')).askForPush()
}

/** Re-reads the permission and registers again (the 「重试」 on a failed registration). */
export async function retryPush(): Promise<PushState> {
  if (Platform.OS === 'web') return state
  return (await import('@/lib/push')).refreshPush()
}
