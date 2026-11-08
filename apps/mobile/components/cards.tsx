import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { colors, lift } from '@/lib/theme'

/**
 * A card in the chat (OpenUI cards, proposals): no bubble (R-14), white with
 * the app's soft lift instead of an outline (decisions 2026-10-27), radius 14
 * as approval and list cards (R-33).
 */
export function ChatCard({ children, highlighted, style }: { children: ReactNode; highlighted?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, highlighted && styles.highlighted, style]}>{children}</View>
}

/**
 * A card button: primary is filled ink, secondary is grey with no stroke
 * (R-31), both pills. `busy` shows a spinner in place of nothing else changing.
 * `hollow` draws a disabled primary as its ink outline at reduced opacity, not a
 * grey fill (the review's 批准合并, #1738); `icon` sits before the label.
 */
export function CardButton({ label, onPress, primary, disabled, busy, destructive, hollow, icon }: {
  label: string; onPress: () => void; primary?: boolean; disabled?: boolean; busy?: boolean; destructive?: boolean; hollow?: boolean; icon?: ReactNode
}) {
  const outline = Boolean(hollow && primary && disabled)
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }} aria-disabled={Platform.OS === 'web' ? Boolean(disabled || busy) : undefined} aria-busy={Platform.OS === 'web' ? Boolean(busy) : undefined} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [styles.button, outline ? styles.outline : primary ? styles.primary : styles.secondary, pressed && { opacity: 0.8 }, disabled && { opacity: outline ? 0.35 : 0.4 }]}>
      {busy ? <Spinner size={14} color={primary ? colors.onInk : colors.secondary} /> : null}
      {icon && !busy ? icon : null}
      <Text style={[styles.buttonText, outline ? { color: colors.ink } : primary ? { color: colors.onInk } : destructive ? { color: colors.danger } : null]}>{label}</Text>
    </Pressable>
  )
}

/** A label and its value on a card (收件人, 主题, 时间…). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === '') return null
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{children}</Text>
    </View>
  )
}

export const cardText = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  body: { fontSize: 15, lineHeight: 22 },
  meta: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  error: { fontSize: 13, lineHeight: 18, color: colors.danger },
})

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', backgroundColor: colors.surface, borderRadius: 14, padding: 16, gap: 12, ...lift },
  highlighted: { shadowColor: colors.accent, shadowOpacity: 0.35, shadowRadius: 14 },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22 },
  primary: { backgroundColor: colors.ink },
  outline: { borderWidth: 1.5, borderColor: colors.ink },
  secondary: { backgroundColor: colors.bubble },
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { flexDirection: 'row', gap: 12 },
  fieldLabel: { width: 56, fontSize: 13, lineHeight: 20, color: colors.secondary },
  fieldValue: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20 },
})
