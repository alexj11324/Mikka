import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

/** The light tick iOS gives a drawer, a menu or a sent message. Nothing on the web. */
export function tap() {
  if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
}

/** The firmer tick of a long press opening a menu. */
export function press() {
  if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
}
