import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
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
 */
export function CardButton({ label, onPress, primary, disabled, busy, destructive }: {
  label: string; onPress: () => void; primary?: boolean; disabled?: boolean; busy?: boolean; destructive?: boolean
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [styles.button, primary ? styles.primary : styles.secondary, pressed && { opacity: 0.8 }, disabled && { opacity: 0.4 }]}>
      {busy ? <Spinner size={14} color={primary ? '#fff' : colors.secondary} /> : null}
      <Text style={[styles.buttonText, primary ? { color: '#fff' } : destructive ? { color: colors.danger } : null]}>{label}</Text>
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
  card: { alignSelf: 'stretch', backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 12, ...lift },
  highlighted: { shadowColor: colors.accent, shadowOpacity: 0.35, shadowRadius: 14 },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, paddingHorizontal: 18, borderRadius: 20 },
  primary: { backgroundColor: colors.ink },
  secondary: { backgroundColor: colors.bubble },
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { flexDirection: 'row', gap: 12 },
  fieldLabel: { width: 56, fontSize: 13, lineHeight: 20, color: colors.secondary },
  fieldValue: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20 },
})
