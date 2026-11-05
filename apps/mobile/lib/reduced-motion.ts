import { useSyncExternalStore } from 'react'
import { AccessibilityInfo, Platform } from 'react-native'

// Share one subscription across message rows and status icons. Native preferences
// are asynchronous; keep decorative motion off until the first value arrives.
let reducedMotion = true
const listeners = new Set<() => void>()
let stop: (() => void) | undefined

function update(value: boolean) {
  if (value === reducedMotion) return
  reducedMotion = value
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const media = window.matchMedia('(prefers-reduced-motion: reduce)')
      update(media.matches)
      const changed = (event: MediaQueryListEvent) => update(event.matches)
      media.addEventListener('change', changed)
      stop = () => media.removeEventListener('change', changed)
    } else {
      let active = true
      let changedSinceRead = false
      const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
        changedSinceRead = true
        update(value)
      })
      void AccessibilityInfo.isReduceMotionEnabled().then(value => {
        if (active && !changedSinceRead) update(value)
      }).catch(() => {})
      stop = () => { active = false; subscription.remove() }
    }
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) { stop?.(); stop = undefined }
  }
}

/** Responds to preference changes while the screen is still open. */
export function useReducedMotionPreference() {
  return useSyncExternalStore(subscribe, () => reducedMotion, () => true)
}
