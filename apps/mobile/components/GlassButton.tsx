import { Platform, Pressable, StyleSheet } from 'react-native'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { Text } from '@/components/Text'
import { Spinner } from '@/components/icons'
import { colors, lift } from '@/lib/theme'

const glass = Platform.OS === 'ios' && isLiquidGlassAvailable()

/**
 * A text action that floats over or beside content (重试): a capsule of the system's interactive Liquid Glass on
 * iOS 26, a white lifted capsule on earlier iOS and the web, so it never blends into the grey bubbles around it.
 */
export function GlassButton({ label, onPress, busy = false, disabled = false }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean }) {
  const blocked = disabled || busy
  const content = <>{busy ? <Spinner size={14} color={colors.secondary} /> : null}<Text style={styles.glassLabel}>{label}</Text></>
  const a11y = { accessibilityRole: 'button' as const, accessibilityState: { disabled: blocked, busy }, 'aria-disabled': Platform.OS === 'web' ? blocked : undefined, 'aria-busy': Platform.OS === 'web' ? busy : undefined, disabled: blocked, onPress }
  if (glass) return <Pressable {...a11y} style={blocked ? { opacity: 0.4 } : undefined}><GlassView isInteractive={!blocked} style={styles.glassCapsule}>{content}</GlassView></Pressable>
  return <Pressable {...a11y} style={({ pressed }) => [styles.glassCapsule, styles.liftedCapsule, blocked && { opacity: 0.4 }, pressed && { backgroundColor: colors.pressed }]}>{content}</Pressable>
}

const styles = StyleSheet.create({
  glassCapsule: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 36, paddingHorizontal: 16, borderRadius: 18 },
  liftedCapsule: { backgroundColor: colors.surface, ...lift },
  glassLabel: { fontSize: 15, fontWeight: '600', color: colors.ink },
})
