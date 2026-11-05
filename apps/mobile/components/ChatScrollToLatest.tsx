import { Platform, Pressable, StyleSheet, View } from 'react-native'
import Reanimated, { cubicBezier } from 'react-native-reanimated'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { ArrowDown } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { colors, lift } from '@/lib/theme'

const glass = Platform.OS === 'ios' && isLiquidGlassAvailable()
/** expo-animation: a state change with no finger on it is a CSS transition, strong ease-out, under 300 ms. */
const FADE = { transitionProperty: 'opacity' as const, transitionDuration: 200, transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1) }

/**
 * Back to the newest message, as in the Claude and ChatGPT apps: a 48-point round glass button with a down arrow,
 * centred just above the composer, shown only while the list is away from its end. It stays mounted and hides by
 * turning its glass to `none` with the system's own animation, because glass stops drawing under any ancestor at zero
 * opacity; only the arrow fades. Earlier iOS and the web draw a white lifted circle that fades the same way.
 */
export function ChatScrollToLatest({ visible, bottom, onPress }: { visible: boolean; bottom: number; onPress: () => void }) {
  const hidden = !visible
  const arrow = (
    <Reanimated.View style={[styles.center, { opacity: hidden ? 0 : 1 }, FADE]}>
      <Symbol name="arrow.down" size={20} color={colors.ink} web={<ArrowDown size={22} color={colors.ink} strokeWidth={2.2} />} />
    </Reanimated.View>
  )
  const button = (
    <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息" accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      aria-hidden={hidden} disabled={hidden} hitSlop={4} onPress={onPress} style={({ pressed }) => [styles.fill, pressed && { opacity: 0.55 }]}>{arrow}</Pressable>
  )
  return (
    <View pointerEvents={hidden ? 'none' : 'box-none'} style={[styles.row, { bottom }]}>
      {glass
        ? <GlassView glassEffectStyle={{ style: hidden ? 'none' : 'regular', animate: true, animationDuration: 0.2 }} isInteractive={!hidden} style={styles.circle}>{button}</GlassView>
        : <Reanimated.View style={[styles.circle, styles.solid, { opacity: hidden ? 0 : 1 }, FADE]}>{button}</Reanimated.View>}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  circle: { width: 48, height: 48, borderRadius: 24, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: 'transparent' },
  solid: { backgroundColor: colors.surface, overflow: 'visible', ...lift },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
