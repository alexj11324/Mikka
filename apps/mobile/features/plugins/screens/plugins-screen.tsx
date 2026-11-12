import { ReadNotice } from '@/components/ReadNotice'
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { Puzzle } from 'lucide-react-native'
import { SourceIcon, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Segmented } from '@/components/Segmented'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { api } from '@/lib/api'
import { usePluginConnections } from '../use-plugin-connections'
import type { SkillsPage, StoreCatalog } from '@/lib/types'
import { useApi, useRefresh } from '@/lib/useApi'
import { openOnWeb } from '@/lib/web'
import { colors, GROUP_INSET } from '@/lib/theme'
import { ListSectionHeader } from '@/shared/components/list-section'

type Tab = 'apps' | 'skills'
type Entry = { id: string; name: string; description: string; iconUrl: string | null; own?: boolean }

/** Mikka's own integrations, listed first as on the web (components/plugins/connected-apps.tsx OWN_APPS). */
const OWN: Entry[] = [
  { id: 'github', name: 'GitHub', description: '', iconUrl: null, own: true },
  { id: 'linear', name: 'Linear', description: '', iconUrl: null, own: true },
  { id: 'telegram', name: 'Telegram', description: '', iconUrl: null, own: true },
]

/** A row's place in its inset group, for the group's rounded ends and hairlines. */
type Place = { first: boolean; last: boolean }
const place = (index: number, count: number): Place => ({ first: index === 0, last: index === count - 1 })

/**
 * 插件 (Comma design 17), the web's plugins page on the phone (components/plugins/plugins-view.tsx):
 * 应用, the store of every app a person can connect, with what they connected
 * first; 技能, skills.sh's leaderboard and search. Connecting and managing an
 * app happen on that app's web page, opened signed in: the provider's sign-in
 * runs in the browser, which holds the flow, and the list reloads on return.
 */
export function PluginsScreen() {
  const [tab, setTab] = useState<Tab>('apps')
  const [query, setQuery] = useState('')
  return (
    <View style={styles.screen}>
      <NavBar title="插件" large search={{ placeholder: tab === 'apps' ? '搜索应用' : '搜索技能', onChange: setQuery }} />
      {tab === 'apps' ? <Apps query={query} header={<Header tab={tab} setTab={setTab} />} />
        : <Skills query={query} header={<Header tab={tab} setTab={setTab} />} />}
    </View>
  )
}

function Header({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  return (
    <View style={styles.header}>
      <Segmented options={[{ value: 'apps', label: '应用' }, { value: 'skills', label: '技能' }]} value={tab} onChange={setTab} />
    </View>
  )
}

function Apps({ query, header }: { query: string; header: ReactElement }) {
  const catalog = useApi<StoreCatalog>('/api/integrations/composio/catalog')
  const connections = usePluginConnections()
  const reload = async () => { await Promise.all([catalog.reload(), connections.reload()]) }
  const refresh = useRefresh(reload)
  const connected = useMemo(() => new Set(connections.snapshot?.toolkits ?? []), [connections.snapshot])
  const byId = new Map<string, Entry>([...OWN, ...(catalog.data?.apps ?? [])].map(app => [app.id, app]))
  const entries = (ids: readonly string[]): Entry[] => ids.flatMap(id => { const app = byId.get(id); return app ? [app] : [] })
  const needle = query.trim().toLowerCase()

  const sections = useMemo(() => {
    if (needle) {
      const hits = [...OWN, ...(catalog.data?.apps ?? []) as Entry[]].filter(app => app.name.toLowerCase().includes(needle) || app.id.includes(needle) || app.description.toLowerCase().includes(needle))
      return [{ title: '', items: hits }]
    }
    const mine: Entry[] = [...connected].map(id => byId.get(id) ?? { id, name: id, description: '', iconUrl: null })
    return [
      { title: '已连接', items: mine },
      { title: '热门', items: [...OWN, ...entries(catalog.data?.popular ?? [])].filter(app => !connected.has(app.id)) },
      { title: '新品推荐', items: entries(catalog.data?.latest ?? []).filter(app => !connected.has(app.id)) },
    ].filter(section => section.items.length)
  }, [needle, catalog.data, connected])

  // Open the app's page on the web, signed in; its 连接 or 管理 happens there.
  const open = async (id: string) => {
    await openOnWeb(`/?section=plugins&app=${id}`)
    await reload()
  }
  const rows = sections.flatMap(section => [
    ...(section.title ? [{ key: `h:${section.title}`, title: section.title }] : []),
    ...section.items.map((item, index) => ({ key: `${section.title}:${item.id}`, item, place: place(index, section.items.length) })),
  ])

  return (
    <FlatList
      data={rows}
      keyExtractor={row => row.key}
      {...underBar}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl {...refresh} />}
      ListHeaderComponent={<>{header}<ReadNotice error={catalog.error || connections.error} hasData={Boolean(catalog.error ? catalog.data : connections.snapshot?.toolkits.length)} label={catalog.error ? "应用目录" : "连接状态"} onRetry={reload} /></>}
      contentContainerStyle={styles.list}
      ListEmptyComponent={catalog.loading ? <View style={styles.center}><Spinner /></View>
        : <Text style={styles.note}>{catalog.error ? '应用加载失败' : needle ? `没有找到「${query.trim()}」` : catalog.data?.configured === false ? '应用商店未配置' : '没有应用'}</Text>}
      renderItem={({ item: row }) => 'title' in row ? <ListSectionHeader title={row.title} grouped /> : (
        <GroupRow place={row.place} label={`${row.item.name}${connected.has(row.item.id) ? '，已连接' : ''}`} onPress={() => void open(row.item.id)}>
          <AppIcon entry={row.item} />
          <Text style={styles.name} numberOfLines={1}>{row.item.name}</Text>
          {connected.has(row.item.id) ? <View style={styles.connected} /> : (connections.error && (!connections.snapshot || connections.snapshot.failed.some(failure => failure.source === (row.item.own ? row.item.id : 'composio')))) ? <Text style={styles.state}>连接状态未知</Text> : null}
          <Symbol name="chevron.right" size={13} color={colors.tertiary} />
        </GroupRow>
      )}
    />
  )
}

/** A row of an inset group (Comma design 17): white on the grouped page, rounded at the group's ends, a hairline between rows. */
function GroupRow({ place: { first, last }, label, onPress, children }: { place: Place; label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.groupRow, first && styles.groupFirst, last && styles.groupLast, pressed && { backgroundColor: colors.pressed }]}>
      {children}
      {last ? null : <View style={styles.hairline} />}
    </Pressable>
  )
}

function AppIcon({ entry }: { entry: Entry }) {
  if (entry.iconUrl) return <Image source={{ uri: entry.iconUrl }} style={styles.icon} />
  if (entry.id === 'github' || entry.id === 'linear') return <View style={styles.icon}><SourceIcon source={entry.id} size={24} /></View>
  return <View style={[styles.icon, styles.iconBlank]}><Symbol name="puzzlepiece.extension" size={16} color={colors.secondary} web={<Puzzle size={16} color={colors.secondary} />} /></View>
}

function Skills({ query, header }: { query: string; header: ReactElement }) {
  // skills.sh's leaderboard, or the search once typing pauses; a page at a time as the list scrolls.
  const [debounced, setDebounced] = useState(query.trim())
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(timer) }, [query])
  const [pages, setPages] = useState<SkillsPage[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const request = useRef(0), busy = useRef(false), failedPage = useRef(0)
  const currentQuery = useRef(debounced)
  currentQuery.current = debounced
  const load = async (page: number, replace = false) => {
    if (busy.current && !replace) return
    const ticket = ++request.current, query = debounced
    if (query.length === 1) { busy.current = false; setPages([]); setLoading(false); setFailed(false); return }
    busy.current = true; failedPage.current = page
    setLoading(true); setFailed(false)
    const current = () => ticket === request.current && query === currentQuery.current
    const params = new URLSearchParams({ ...(query ? { q: query } : {}), ...(page ? { page: String(page) } : {}) })
    try {
      const next = await api<SkillsPage>(`/api/skills/search${params.size ? `?${params}` : ''}`)
      if (current()) setPages(previous => page ? [...previous, next] : [next])
    } catch { if (current()) setFailed(true) }
    finally { if (current()) { busy.current = false; setLoading(false) } }
  }
  useEffect(() => {
    setPages([]); void load(0, true)
    return () => { request.current++; busy.current = false }
  }, [debounced])
  const refresh = useRefresh(() => load(0))
  const skills = pages.flatMap(page => page.data)
  const hasMore = Boolean(pages.at(-1)?.hasMore)

  return (
    <FlatList
      data={skills}
      keyExtractor={skill => skill.id}
      {...underBar}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl {...refresh} />}
      ListHeaderComponent={<>{header}<ReadNotice error={failed} hasData={pages.length > 0} label="技能" onRetry={() => load(failedPage.current)} /></>}
      contentContainerStyle={styles.list}
      onEndReachedThreshold={0.6}
      onEndReached={() => { if (hasMore && !loading && !failed) void load(pages.length) }}
      ListFooterComponent={loading && skills.length ? <View style={styles.center}><Spinner /></View> : undefined}
      ListEmptyComponent={loading ? <View style={styles.center}><Spinner /></View>
        : failed ? undefined : <Text style={styles.note}>{debounced.length === 1 ? '再多输入一个字' : debounced ? `没有找到「${debounced}」` : '没有技能'}</Text>}
      renderItem={({ item, index }) => (
        <GroupRow place={place(index, skills.length)} label={item.name} onPress={() => void WebBrowser.openBrowserAsync(item.url)}>
          <View style={[styles.icon, styles.iconBlank]}><Symbol name="sparkles" size={16} color={colors.secondary} web={<Puzzle size={16} color={colors.secondary} />} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.detail} numberOfLines={1}>{item.source} · {item.installs.toLocaleString()} 次安装</Text>
          </View>
          <Symbol name="arrow.up.right" size={12} color={colors.tertiary} />
        </GroupRow>
      )}
    />
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.grouped },
  header: { paddingHorizontal: GROUP_INSET, paddingTop: 8, paddingBottom: 4 },
  list: { paddingBottom: 32 },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, marginHorizontal: GROUP_INSET, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.surface },
  groupFirst: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  groupLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  hairline: { position: 'absolute', left: 60, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  icon: { width: 30, height: 30, borderRadius: 7, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  iconBlank: { backgroundColor: colors.bubble },
  name: { flex: 1, minWidth: 0, fontSize: 17 },
  detail: { fontSize: 13, color: colors.secondary, marginTop: 2 },
  state: { fontSize: 14, color: colors.secondary },
  connected: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  center: { paddingVertical: 32, alignItems: 'center' },
  note: { textAlign: 'center', color: colors.secondary, marginTop: 32, fontSize: 15 },
})
