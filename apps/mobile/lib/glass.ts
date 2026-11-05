import { useEffect, useState } from 'react'
import { AccessibilityInfo, Platform } from 'react-native'
import { isLiquidGlassAvailable } from 'expo-glass-effect'

const available = Platform.OS === 'ios' && isLiquidGlassAvailable()

/**
 * Whether to draw Liquid Glass: iOS 26, unless Reduce Transparency is on, when controls are the solid lifted
 * surface instead (DESIGN.md § Glass). Follows the setting while the app runs.
 */
export function useLiquidGlass() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (!available) return
    let live = true
    void AccessibilityInfo.isReduceTransparencyEnabled().then(value => { if (live) setReduced(value) }).catch(() => undefined)
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduced)
    return () => { live = false; subscription.remove() }
  }, [])
  return available && !reduced
}
