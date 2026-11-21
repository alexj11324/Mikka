import { Children, type ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { GlassView } from 'expo-glass-effect'
import { mobileMessages as messages } from '@/lib/messages'
import { useLiquidGlass } from '@/lib/glass'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, X } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { Spinner } from '@/components/icons'
import { colors, lift, SPACE } from '@/lib/theme'


/**
 * A round floating button (the web bar's buttons). On
 * iOS 26 it is the system's interactive Liquid Glass; earlier iOS and the web
 * draw a white circle with a soft lift.
 */
export function RoundButton({ onPress, children, label, dot, disabled = false, busy = false }: { onPress?: () => void; children: ReactNode; label: string; dot?: boolean; disabled?: boolean; busy?: boolean }) {
  const blocked = disabled || busy
  const content = busy ? <Spinner size={20} color={colors.ink} /> : children
  const glass = useLiquidGlass()
  if (glass) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked, busy }} aria-disabled={Platform.OS === 'web' ? blocked : undefined} aria-busy={Platform.OS === 'web' ? busy : undefined} disabled={blocked} onPress={onPress} style={blocked ? { opacity: 0.4 } : undefined}>
        <GlassView isInteractive={!blocked} style={styles.glassRound}>{content}</GlassView>
        {dot ? <View style={styles.dot} /> : null}
      </Pressable>
    )
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked, busy }} aria-disabled={Platform.OS === 'web' ? blocked : undefined} aria-busy={Platform.OS === 'web' ? busy : undefined} disabled={blocked} onPress={onPress}
      style={({ pressed }) => [styles.round, blocked && { opacity: 0.4 }, pressed && { backgroundColor: colors.pressed }]}>
      {content}
      {dot ? <View style={styles.dot} /> : null}
    </Pressable>
  )
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return <RoundButton label={messages.Shell.panel.back} onPress={onPress}><ChevronLeft size={22} color={colors.ink} strokeWidth={2.2} /></RoundButton>
}

export function CloseButton({ onPress }: { onPress: () => void }) {
  return <RoundButton label="关闭" onPress={onPress}><X size={20} color={colors.ink} strokeWidth={2.2} /></RoundButton>
}

/** Top bar: left button, centred title (or a pill), right button. Floats over the content, no bar background. */
export function Header({ left, title, right, subtitle, style }: { left?: ReactNode; title?: ReactNode; right?: ReactNode; subtitle?: string; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets()
  const count = Math.max(1, Children.count(left), Children.count(right))
  const sideWidth = count * 44 + (count - 1) * 8
  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }, style]}>
      <View style={[styles.side, { width: sideWidth }]}>{left}</View>
      <View style={styles.titleBox}>
        {typeof title === 'string' ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : title}
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, { width: sideWidth, justifyContent: 'flex-end' }]}>{right}</View>
    </View>
  )
}

/** A capsule for the bar's title (the bot's name): Liquid Glass on iOS 26, white with a lift elsewhere. */
export function Capsule({ children }: { children: ReactNode }) {
  const glass = useLiquidGlass()
  return glass
    ? <GlassView style={styles.capsule}>{children}</GlassView>
    : <View style={[styles.capsule, { backgroundColor: colors.surface }, lift]}>{children}</View>
}

/** A field's surface (the composer): Liquid Glass on iOS 26, white with a lift elsewhere. */
export function Field({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  const glass = useLiquidGlass()
  return glass ? <GlassView style={[style, { backgroundColor: undefined }]}>{children}</GlassView> : <View style={[style, lift]}>{children}</View>
}

/** Grouped list section, iOS inset style, no outline. `backgroundColor` overrides the card when the section sits on a surface that is already `colors.surface`. */
export function Group({ label, children, backgroundColor }: { label?: string; children: ReactNode; backgroundColor?: string }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean)
  return (
    <View style={{ marginBottom: SPACE.section }}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={[styles.group, backgroundColor ? { backgroundColor } : null]}>
        {items.map((child, index) => (
          <View key={index}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {child}
          </View>
        ))}
      </View>
    </View>
  )
}

export function Dot({ color = colors.unread }: { color?: string }) {
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
}

const styles = StyleSheet.create({
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...lift },
  dot: { position: 'absolute', top: 8, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.unread, borderWidth: 1.5, borderColor: colors.surface },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, zIndex: 10 },
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleBox: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 11, color: colors.secondary, marginTop: 1 },
  glassRound: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  capsule: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 22, maxWidth: 220 },
  groupLabel: { fontSize: 13, color: colors.secondary, marginLeft: 16, marginBottom: 7 },
  group: { backgroundColor: colors.surface, borderRadius: 14, borderCurve: 'continuous', overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 16 },
})
