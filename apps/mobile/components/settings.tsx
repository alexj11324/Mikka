import type { ReactNode } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, ChevronRight } from 'lucide-react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { API_URL } from '@/lib/config'
import { NavBar, underBar } from '@/components/NavBar'
import { colors } from '@/lib/theme'

/** The person's photo, or their initials on green when they have none. */
export function Avatar({ name, image, size }: { name: string; image: string | null; size: number }) {
  // The server's default avatars are paths under its base path (lib/default-avatar.ts).
  if (image) return <Image source={{ uri: image.startsWith('/') ? `${API_URL}${image}` : image }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.38 }]}>{name.trim().slice(0, 2).toUpperCase()}</Text>
    </View>
  )
}

/** A settings sub-page: the system bar with back and the title, grouped rows (R-70). */
export function SettingsPage({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <NavBar back={() => router.back()} title={title} />
      <ScrollView {...underBar} contentContainerStyle={{ padding: 16, paddingBottom: footer ? 16 : insets.bottom + 24 }}>{children}</ScrollView>
      {footer ? <KeyboardStickyView offset={{ opened: insets.bottom - 8 }}>{footer}</KeyboardStickyView> : null}
    </View>
  )
}

export function Row({ icon, label, detail, value, onPress, trailing, destructive }: {
  icon?: ReactNode; label: string; detail?: string; value?: string; onPress?: () => void; trailing?: ReactNode; destructive?: boolean
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
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      {content}
    </Pressable>
  )
}

export function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (next: boolean) => void }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.success, false: '#E3E3E8' }} thumbColor="#fff" {...{ activeThumbColor: '#fff' }} />
    </View>
  )
}

export function ChoiceRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <Text style={[styles.label, { flex: 1 }]}>{label}</Text>
      {selected ? <Symbol name="checkmark" size={15} color={colors.accent} web={<Check size={18} color={colors.accent} strokeWidth={2.4} />} /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, gap: 12, backgroundColor: '#fff' },
  icon: { minWidth: 24, alignItems: 'center' },
  label: { fontSize: 16 },
  detail: { fontSize: 12, color: colors.secondary, marginTop: 2 },
  value: { fontSize: 15, color: colors.secondary, maxWidth: 200 },
  avatar: { backgroundColor: '#55705F', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '600' },
})
