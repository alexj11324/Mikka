import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDrawer } from '@/components/Drawer'
import { MenuIcon, SourceIcon, Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { shortWhen } from '@/lib/clock'
import type { Suggestion, Suggestions } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { colors } from '@/lib/theme'

const VERB: Record<string, string> = { reply: '回复', review: '审阅', handle: '处理', read: '查看' }
const APP: Record<string, string> = { gmail: 'Gmail', slack: 'Slack', notion: 'Notion', github: 'GitHub', linear: 'Linear' }
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * 建议: today's items in one list, each led by its app's icon and a verb
 * (R-21, R-45). Tapping one hands it to the Coordinator, as on the web.
 */
export default function SuggestionsScreen() {
  const drawer = useDrawer()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { data, error, loading } = useApi<Suggestions>(`/api/suggestions?tz=${encodeURIComponent(timeZone)}`)
  const items = (data?.groups ?? []).flatMap(group => group.items).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  const arrange = (item: Suggestion) => router.replace({ pathname: '/', params: { draft: [`${VERB[item.action] ?? ''}：${item.title}`, item.url].filter(Boolean).join('\n') } })

  return (
    <View style={styles.screen}>
      <NavBar left={{ icon: 'line.3.horizontal', label: '菜单', onPress: drawer.open, web: <MenuIcon /> }} title="建议" />
      <FlatList
        data={items}
        keyExtractor={item => item.id}
        {...underBar}
        ListHeaderComponent={<>
          {loading ? <View style={styles.center}><Spinner /></View> : null}
          {!loading && error ? <Text style={styles.note}>建议加载失败。</Text> : null}
          {!loading && data && !items.length ? <Text style={styles.note}>今天还没有新的建议。</Text> : null}
        </>}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        renderItem={({ item, index }) => (
          <Pressable accessibilityRole="button" onPress={() => arrange(item)}
            style={({ pressed }) => [styles.row, index === 0 && styles.first, index === items.length - 1 && styles.last, pressed && { backgroundColor: colors.pressed }]}>
            <SourceIcon source={item.source} size={20} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={1}>{VERB[item.action] ? `${VERB[item.action]}：` : ''}{item.title}</Text>
              <Text style={styles.meta} numberOfLines={1}>{[APP[item.source] ?? item.source, item.actor, shortWhen(item.occurredAt)].filter(Boolean).join(' · ')}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.grouped },
  center: { paddingTop: 40, alignItems: 'center' },
  note: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  list: { paddingHorizontal: 16, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 10 },
  first: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 14 },
  last: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, paddingBottom: 14 },
  title: { fontSize: 16 },
  meta: { fontSize: 12, color: colors.secondary, marginTop: 2 },
})
