import { Platform, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { colors } from '@/lib/theme'

/** The bar's own height under the status bar on iOS: the back button and title capsule. */
const BAR = 54
/** How far below the bar the page fades back into view. */
const FADE = 28

/**
 * The page's colour behind a chat's transparent bar, fading out just below it,
 * so a long reply scrolled up does not show through the back button and title
 * capsule (Alex, 2026-11-02). The system's soft edge alone leaves the words
 * readable there. It takes no touches; the bar's buttons sit above it.
 */
export function TopScrim() {
  const insets = useSafeAreaInsets()
  if (Platform.OS !== 'ios') return null
  const solid = insets.top + BAR
  const height = solid + FADE
  return (
    <View pointerEvents="none" style={[styles.scrim, { height }]}>
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor={colors.page} stopOpacity={1} />
            <Stop offset={solid / height} stopColor={colors.page} stopOpacity={0.96} />
            <Stop offset={1} stopColor={colors.page} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={height} fill="url(#scrim)" />
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0 },
})
