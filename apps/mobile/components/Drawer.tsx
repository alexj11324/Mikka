import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePathname, useRouter, type Href } from 'expo-router'
import { CircleArrowDown, CodeXml, Inbox, ListChecks, PenLine, Search, X } from 'lucide-react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { Dot, RoundButton } from '@/components/ui'
import { useHome } from '@/lib/home'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { colors, font } from '@/lib/theme'

type DrawerState = { open: () => void; close: () => void; isOpen: boolean }
const DrawerContext = createContext<DrawerState>({ open: () => {}, close: () => {}, isOpen: false })
export const useDrawer = () => useContext(DrawerContext)

/**
 * The side drawer, like the ChatGPT iOS app (mobile.md "Where it lives"): it
 * slides in from the left and pushes the current screen right.
 */
export function DrawerHost({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions()
  const panel = Math.min(width * 0.82, 340)
  const [isOpen, setOpen] = useState(false)
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(progress, { toValue: isOpen ? 1 : 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()
  }, [isOpen, progress])

  const value = useMemo(() => ({ open: () => setOpen(true), close: () => setOpen(false), isOpen }), [isOpen])
  const shift = progress.interpolate({ inputRange: [0, 1], outputRange: [0, panel] })
  const panelShift = progress.interpolate({ inputRange: [0, 1], outputRange: [-panel * 0.3, 0] })

  return (
    <DrawerContext.Provider value={value}>
      <View style={styles.root}>
        <Animated.View style={[styles.panel, { width: panel, transform: [{ translateX: panelShift }] }]} pointerEvents={isOpen ? 'auto' : 'none'}>
          <DrawerPanel onNavigate={() => setOpen(false)} />
        </Animated.View>
        <Animated.View style={[styles.content, isOpen && styles.contentOpen, { transform: [{ translateX: shift }] }]}>
          {children}
          {isOpen ? <Pressable accessibilityLabel="关闭菜单" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} /> : null}
        </Animated.View>
      </View>
    </DrawerContext.Provider>
  )
}

function DrawerPanel({ onNavigate }: { onNavigate: () => void }) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const path = usePathname()
  const go = (href: Href) => { onNavigate(); setQuery(null); router.replace(href) }
  const { data } = useHome()
  const updateReady = useUpdateReady()
  // 最近: newest chat first (mobile.md). Pinning is not on the server yet, so there is no 置顶 group.
  // Search filters the drawer by name, as ChatGPT iOS's drawer search does with its chats.
  const [query, setQuery] = useState<string | null>(null)
  const needle = query?.trim().toLowerCase() ?? ''
  const shows = (label: string) => !needle || label.toLowerCase().includes(needle)
  const bots = [...data?.bots ?? []].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).filter(bot => shows(bot.name))
  const initials = (data?.user.name || data?.user.email || '').trim().slice(0, 2).toUpperCase()
  const nothing = needle && !bots.length && !['Coordinator', '建议', '线程', '任务'].some(shows)

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }}>
      <View style={styles.top}>
        {query === null ? <Text style={styles.brand}>Mikka</Text> : (
          <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="搜索" placeholderTextColor={colors.tertiary} returnKeyType="search"
            accessibilityLabel="搜索" style={styles.search} />
        )}
        {query === null
          ? <RoundButton label="搜索" onPress={() => setQuery('')}><Search size={20} color={colors.ink} strokeWidth={2} /></RoundButton>
          : <RoundButton label="取消搜索" onPress={() => setQuery(null)}><X size={20} color={colors.ink} strokeWidth={2} /></RoundButton>}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 16 }}>
        {shows('Coordinator') ? <Row active={path === '/'} onPress={() => go('/')} icon={<BotAvatar size={24} />} label="Coordinator" /> : null}
        {shows('建议') ? <Row active={path === '/suggestions'} onPress={() => go('/suggestions')} icon={<Inbox size={22} color={colors.ink} strokeWidth={1.8} />} label="建议"
          trailing={data?.suggestions ? <Text style={styles.count}>{data.suggestions}</Text> : null} /> : null}
        {shows('线程') ? <Row active={path.startsWith('/threads')} onPress={() => go('/threads')} icon={<CodeXml size={22} color={colors.ink} strokeWidth={1.8} />} label="线程"
          trailing={data?.threads.waiting ? <Dot /> : data?.threads.running ? <Text style={styles.count}>{data.threads.running} 运行中</Text> : null} /> : null}
        {shows('任务') ? <Row active={path === '/tasks'} onPress={() => go('/tasks')} icon={<ListChecks size={22} color={colors.ink} strokeWidth={1.8} />} label="任务" /> : null}
        {updateReady && !needle ? <Row onPress={restartToUpdate} icon={<CircleArrowDown size={22} color={colors.ink} strokeWidth={1.8} />} label="重启以更新" /> : null}
        {nothing ? <Text style={styles.none}>没有找到「{query?.trim()}」。</Text> : null}
        {bots.length && !needle ? <Text style={styles.section}>最近</Text> : null}
        {bots.map(bot => (
          <Row key={bot.id} active={path === `/bots/${bot.id}`} onPress={() => go(`/bots/${bot.id}`)} icon={<BotAvatar color={bot.color} shape={bot.shape} size={24} />} label={bot.name}
            trailing={bot.working ? <Spinner size={14} /> : null} />
        ))}
      </ScrollView>
      <View style={styles.bottom}>
        <Pressable accessibilityRole="button" onPress={() => go('/')} style={styles.newButton}>
          <PenLine size={18} color="#fff" strokeWidth={2} />
          <Text style={styles.newLabel}>新建</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="设置" onPress={() => { onNavigate(); router.push('/settings') }} style={styles.me}>
          <Text style={styles.meText}>{initials}</Text>
        </Pressable>
      </View>
    </View>
  )
}

function Row({ icon, label, trailing, active, onPress }: { icon: ReactNode; label: string; trailing?: ReactNode; active?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, (active || pressed) && styles.rowActive]}>
      <View style={styles.rowIcon}>{icon}</View>
      <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
      {trailing}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.grouped, overflow: 'hidden' },
  panel: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: colors.grouped },
  content: { flex: 1, backgroundColor: colors.page, overflow: 'hidden' },
  contentOpen: { borderTopLeftRadius: 28, borderBottomLeftRadius: 28, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: -2, height: 0 } },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 12 },
  brand: { fontSize: 28, fontWeight: '700' },
  search: { flex: 1, minWidth: 0, width: 0, marginRight: 12, height: 44, borderRadius: 22, backgroundColor: '#E4E4E6', paddingHorizontal: 16, fontSize: 16, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  none: { fontSize: 14, color: colors.secondary, marginTop: 12, marginLeft: 12 },
  row: { flexDirection: 'row', alignItems: 'center', height: 48, paddingHorizontal: 12, borderRadius: 14, gap: 14 },
  rowActive: { backgroundColor: '#E4E4E6' },
  rowIcon: { width: 26, alignItems: 'center' },
  rowLabel: { flex: 1, fontSize: 16 },
  count: { fontSize: 14, color: colors.secondary },
  section: { fontSize: 13, color: colors.secondary, marginTop: 18, marginBottom: 6, marginLeft: 12 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8 },
  newButton: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, paddingHorizontal: 20, borderRadius: 24, backgroundColor: colors.accent },
  newLabel: { color: '#fff', fontSize: 16, fontWeight: '600' },
  me: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#3D7A5C', alignItems: 'center', justifyContent: 'center' },
  meText: { color: '#fff', fontWeight: '600', fontSize: 15 },
})
