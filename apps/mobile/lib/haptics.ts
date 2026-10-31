import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

/** The light tick iOS gives a drawer, a menu or a sent message. Nothing on the web. */
export function tap() {
  if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
}
