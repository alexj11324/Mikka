import { type ReactNode, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, ChevronLeft, X } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { colors, font, lift } from '@/lib/theme'

/** A round floating button in a header (menu, back, search, close). */
export function RoundButton({ onPress, children, label, dot }: { onPress?: () => void; children: ReactNode; label: string; dot?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
      style={({ pressed }) => [styles.round, pressed && { backgroundColor: colors.pressed }]}>
      {children}
      {dot ? <View style={styles.dot} /> : null}
    </Pressable>
  )
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return <RoundButton label="返回" onPress={onPress}><ChevronLeft size={22} color={colors.ink} strokeWidth={2.2} /></RoundButton>
}

export function CloseButton({ onPress }: { onPress: () => void }) {
  return <RoundButton label="关闭" onPress={onPress}><X size={20} color={colors.ink} strokeWidth={2.2} /></RoundButton>
}

/** Top bar: left button, centred title (or a pill), right button. Floats over the content, no bar background. */
export function Header({ left, title, right, subtitle, style }: { left?: ReactNode; title?: ReactNode; right?: ReactNode; subtitle?: string; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }, style]}>
      <View style={styles.side}>{left}</View>
      <View style={styles.titleBox}>
        {typeof title === 'string' ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : title}
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, { alignItems: 'flex-end' }]}>{right}</View>
    </View>
  )
}

/**
 * The composer: one rounded field holding the text and send (Alex
 * 2026-10-27). The 「+」 and the mic come back inside the field, at its ends,
 * when attachments and dictation exist; until then they are left out rather
 * than drawn as buttons that do nothing. The text stays until `onSend`
 * resolves true (the server took it), so a failed send loses nothing.
 * Controlled when `value` and `onChangeText` are passed.
 */
export function Composer({ placeholder, onSend, initial = '', disabled = false, value, onChangeText }: {
  placeholder: string
  onSend?: (text: string) => boolean | void | Promise<boolean | void>
  initial?: string
  disabled?: boolean
  value?: string
  onChangeText?: (text: string) => void
}) {
  const insets = useSafeAreaInsets()
  const [own, setOwn] = useState(initial)
  const [sending, setSending] = useState(false)
  const text = value ?? own
  const setText = onChangeText ?? setOwn
  const blocked = disabled || sending
  const send = async () => {
    const message = text.trim()
    if (!message || blocked) return
    setSending(true)
    try {
      const ok = await onSend?.(message)
      if (ok !== false) setText('')
    } finally {
      setSending(false)
    }
  }
  return (
    <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <View style={styles.field}>
        <TextInput value={text} onChangeText={setText} onSubmitEditing={() => void send()} placeholder={placeholder} editable={!blocked}
          placeholderTextColor={colors.tertiary} style={[styles.input, sending && { color: colors.secondary }]} returnKeyType="send" />
        <Pressable accessibilityRole="button" accessibilityLabel="发送" accessibilityState={{ disabled: blocked || !text.trim() }} onPress={() => void send()} disabled={blocked}
          style={[styles.send, (blocked || !text.trim()) && { backgroundColor: colors.tertiary }]}>
          <ArrowUp size={20} color="#fff" strokeWidth={2.4} />
        </Pressable>
      </View>
    </View>
  )
}

/** Grouped list section, iOS inset style, no outline. */
export function Group({ label, children }: { label?: string; children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean)
  return (
    <View style={{ marginBottom: 20 }}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={styles.group}>
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
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...lift },
  dot: { position: 'absolute', top: 8, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.unread, borderWidth: 1.5, borderColor: '#fff' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, zIndex: 10 },
  side: { width: 64 },
  titleBox: { flex: 1, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 11, color: colors.secondary, marginTop: 1 },
  composerWrap: { paddingHorizontal: 16, paddingTop: 10 },
  field: { flexDirection: 'row', alignItems: 'center', height: 52, borderRadius: 26, backgroundColor: '#fff', paddingLeft: 18, paddingRight: 6, gap: 10, ...lift },
  input: { flex: 1, minWidth: 0, width: 0, fontFamily: font, fontSize: 16, color: colors.text, paddingVertical: 0, outlineStyle: 'none' } as never,
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  groupLabel: { fontSize: 13, color: colors.secondary, marginLeft: 16, marginBottom: 7 },
  group: { backgroundColor: colors.surface, borderRadius: 14, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 16 },
})
