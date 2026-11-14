import { mobileMessages as messages } from '@/lib/messages'
import { ReadNotice } from '@/components/ReadNotice'
import { useSettings } from '@/lib/settings'
import { useEffect, useState, type ReactNode } from 'react'
import { Image, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, ChevronRight } from 'lucide-react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { Spinner } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { API_URL } from '@/lib/config'
import { NavBar, underBar } from '@/components/NavBar'
import { colors } from '@/lib/theme'

/** The person's photo, or their initials on green when they have none. */
export function Avatar({ name, image, size }: { name: string; image: string | null; size: number }) {
  // Resolve the API's default/uploaded avatar paths for native and Expo Web.
  const uri = image ? (image.startsWith('/') ? `${API_URL}${image}` : image) : null
  const [result, setResult] = useState<{ uri: string; ok: boolean } | null>(null)
  useEffect(() => { setResult(null) }, [uri])
  const ready = Boolean(uri && result?.uri === uri && result.ok)
  const failed = Boolean(uri && result?.uri === uri && !result.ok)
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.38 }]}>{name.trim().slice(0, 2).toUpperCase()}</Text>
      {uri && !failed ? <Image source={{ uri }} accessibilityIgnoresInvertColors
        onLoad={() => setResult({ uri, ok: true })} onError={() => setResult({ uri, ok: false })}
        style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]} /> : null}
    </View>
  )
}

/** A settings sub-page: the system bar with back and the title, grouped rows (R-70). */
export function SettingsPage({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { data, error, loading, reload } = useSettings()
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <NavBar back={() => router.canGoBack() ? router.back() : router.replace('/settings')} title={title} />
      <ScrollView {...underBar} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: footer ? 16 : insets.bottom + 24 }}>
        <ReadNotice error={error} hasData={Boolean(data)} label={messages.Settings.title} onRetry={reload} />
        {!data && loading ? <View style={{ padding: 24, alignItems: 'center' }}><Spinner /></View> : null}
        {data ? children : null}
      </ScrollView>
      {footer && data ? <KeyboardStickyView offset={{ opened: insets.bottom - 8 }}>{footer}</KeyboardStickyView> : null}
    </View>
  )
}

export function Row({ icon, label, detail, value, onPress, onLongPress, trailing, destructive, disabled = false }: {
  icon?: ReactNode; label: string; detail?: string; value?: string; onPress?: () => void; onLongPress?: () => void; trailing?: ReactNode; destructive?: boolean; disabled?: boolean
}) {
  const content = (
    <>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <View style={{ flex: 1 }}>
        <Text style={[styles.label, destructive && { color: colors.danger }]}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {value ? <Text style={styles.value} numberOfLines={1}>{value}</Text> : null}
      {trailing !== undefined ? trailing : onPress && !destructive ? <Symbol name="chevron.right" size={13} color={colors.tertiary} web={<ChevronRight size={18} color={colors.tertiary} strokeWidth={2} />} /> : null}
    </>
  )
  // A row without its own action stays a View, so a button in `trailing` is not nested in another button.
  if (!onPress) return <View style={styles.row}>{content}</View>
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} aria-disabled={Platform.OS === 'web' ? disabled : undefined} disabled={disabled} onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }, disabled && { opacity: 0.5 }]}>
      {content}
    </Pressable>
  )
}

export function ToggleRow({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { flex: 1 }]}>{label}</Text>
      <Switch accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} value={value} disabled={disabled} onValueChange={onChange} trackColor={{ true: colors.success, false: colors.chip }} thumbColor="#fff" {...{ activeThumbColor: '#fff' }} />
    </View>
  )
}

/** A row to pick one of several; `busy` spins in place of the tick while the pick is saved. */
export function ChoiceRow({ label, selected, busy = false, disabled = false, onPress }: { label: string; selected: boolean; busy?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected, busy, disabled: disabled || busy }} aria-checked={Platform.OS === 'web' ? selected : undefined} aria-busy={Platform.OS === 'web' ? busy : undefined} aria-disabled={Platform.OS === 'web' ? disabled || busy : undefined} disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <Text style={[styles.label, { flex: 1 }]}>{label}</Text>
      {busy ? <Spinner size={15} /> : selected ? <Symbol name="checkmark" size={15} color={colors.accent} web={<Check size={18} color={colors.accent} strokeWidth={2.4} />} /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, gap: 12, backgroundColor: colors.surface },
  icon: { minWidth: 24, alignItems: 'center' },
  label: { fontSize: 17 },
  detail: { fontSize: 12, color: colors.secondary, marginTop: 2 },
  value: { fontSize: 15, color: colors.secondary, maxWidth: 200 },
  avatar: { backgroundColor: '#55705F', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '600' },
})
