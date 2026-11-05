import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { GlassView } from 'expo-glass-effect'
import { useLiquidGlass } from '@/lib/glass'
import { colors, lift } from '@/lib/theme'

/**
 * A control floating over the chat (selection capsules, the queue card): interactive Liquid Glass on iOS 26, a solid
 * lifted surface elsewhere or under Reduce Transparency. `hidden` turns the glass off with the system's own
 * animation rather than fading it, because glass stops drawing under a transparent parent (DESIGN.md § Glass).
 */
export function ChatGlass({ children, style, hidden = false, interactive = false }: { children: ReactNode; style?: StyleProp<ViewStyle>; hidden?: boolean; interactive?: boolean }) {
  const glass = useLiquidGlass()
  if (glass) return <GlassView glassEffectStyle={{ style: hidden ? 'none' : 'regular', animate: true, animationDuration: 0.2 }} isInteractive={interactive && !hidden} style={[styles.clip, style]}>{children}</GlassView>
  return <View style={[styles.solid, style, hidden && styles.gone]}>{children}</View>
}

/** A glass capsule button, 40 pt tall with a 44 pt target. */
export function ChatGlassCapsule({ label, onPress, disabled = false, hidden = false, children }: { label: string; onPress: () => void; disabled?: boolean; hidden?: boolean; children: ReactNode }) {
  const blocked = disabled || hidden
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked }} aria-disabled={Platform.OS === 'web' ? blocked : undefined}
      disabled={blocked} hitSlop={2} onPress={onPress} style={({ pressed }) => [disabled && { opacity: 0.45 }, pressed && { opacity: 0.55 }]}>
      <ChatGlass hidden={hidden} interactive style={styles.capsule}>{children}</ChatGlass>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', borderCurve: 'continuous' },
  solid: { backgroundColor: colors.surface, borderCurve: 'continuous', ...lift },
  gone: { opacity: 0 },
  capsule: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
})
