import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { Puzzle, Search } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { MenuIcon, SourceIcon, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Segmented } from '@/components/Segmented'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { Field } from '@/components/ui'
import { api } from '@/lib/api'
import type { ComposioAccounts, SkillsPage, StoreCatalog } from '@/lib/types'
import { useApi, useRefresh } from '@/lib/useApi'
import { openOnWeb } from '@/lib/web'
import { colors, font } from '@/lib/theme'

type Tab = 'apps' | 'skills'
type Entry = { id: string; name: string; description: string; iconUrl: string | null; own?: boolean }

/** Mikka's own integrations, listed first as on the web (components/plugins/connected-apps.tsx OWN_APPS). */
const OWN: Entry[] = [
  { id: 'github', name: 'GitHub', description: '', iconUrl: null, own: true },
  { id: 'linear', name: 'Linear', description: '', iconUrl: null, own: true },
  { id: 'telegram', name: 'Telegram', description: '', iconUrl: null, own: true },
]

/**
 * 插件, the web's plugins page on the phone (components/plugins/plugins-view.tsx):
 * 应用, the store of every app a person can connect, with what they connected
 * first; 技能, skills.sh's leaderboard and search. Connecting and managing an
 * app happen on that app's web page, opened signed in: the provider's sign-in
 * runs in the browser, which holds the flow, and the list reloads on return.
 */
export default function PluginsScreen() {
  const drawer = useDrawer()
  const [tab, setTab] = useState<Tab>('apps')
  const [query, setQuery] = useState('')
  return (
    <View style={styles.screen}>
      <NavBar left={{ icon: 'line.3.horizontal', label: '菜单', onPress: drawer.open, web: <MenuIcon /> }} title="插件" />
      {tab === 'apps' ? <Apps query={query} header={<Header tab={tab} setTab={setTab} query={query} setQuery={setQuery} />} />
        : <Skills query={query} header={<Header tab={tab} setTab={setTab} query={query} setQuery={setQuery} />} />}
    </View>
  )
}

function Header({ tab, setTab, query, setQuery }: { tab: Tab; setTab: (tab: Tab) => void; query: string; setQuery: (query: string) => void }) {
  return (
    <View style={styles.header}>
      <Segmented options={[{ value: 'apps', label: '应用' }, { value: 'skills', label: '技能' }]} value={tab} onChange={next => { setTab(next); setQuery('') }} />
      <Field style={styles.search}>
        <Symbol name="magnifyingglass" size={16} color={colors.secondary} web={<Search size={16} color={colors.secondary} strokeWidth={2} />} />
        <TextInput value={query} onChangeText={setQuery} placeholder={tab === 'apps' ? '搜索应用' : '搜索技能'} placeholderTextColor={colors.secondary}
          returnKeyType="search" clearButtonMode="while-editing" autoCorrect={false} autoCapitalize="none" style={styles.searchInput} accessibilityLabel="搜索" />
      </Field>
    </View>
  )
}

function Apps({ query, header }: { query: string; header: ReactElement }) {
  const catalog = useApi<StoreCatalog>('/api/integrations/composio/catalog')
  const accounts = useApi<ComposioAccounts>('/api/integrations/composio')
  const reload = async () => { await Promise.all([catalog.reload(), accounts.reload()]) }
  const refresh = useRefresh(reload)
  const connected = new Set((accounts.data?.accounts ?? []).map(account => account.toolkit))
  const byId = new Map<string, Entry>((catalog.data?.apps ?? []).map(app => [app.id, app]))
  const entries = (ids: readonly string[]): Entry[] => ids.flatMap(id => { const app = byId.get(id); return app ? [app] : [] })
  const needle = query.trim().toLowerCase()

  const sections = useMemo(() => {
    if (needle) {
      const hits = [...OWN, ...(catalog.data?.apps ?? []) as Entry[]].filter(app => app.name.toLowerCase().includes(needle) || app.id.includes(needle) || app.description.toLowerCase().includes(needle))
      return [{ title: '', items: hits }]
    }
    const mine = [...connected].flatMap(id => byId.get(id) ?? []) as Entry[]
    return [
      { title: '已连接', items: mine },
      { title: '热门', items: [...OWN, ...entries(catalog.data?.popular ?? []).filter(app => !connected.has(app.id))] },
      { title: '新品推荐', items: entries(catalog.data?.latest ?? []).filter(app => !connected.has(app.id)) },
    ].filter(section => section.items.length)
  }, [needle, catalog.data, accounts.data])

  // Open the app's page on the web, signed in; its 连接 or 管理 happens there.
  const open = async (id: string) => {
    await openOnWeb(`/?section=plugins&app=${id}`)
    await reload()
  }
  const rows = sections.flatMap(section => [
    ...(section.title ? [{ key: `h:${section.title}`, title: section.title }] : []),
    ...section.items.map(item => ({ key: `${section.title}:${item.id}`, item })),
  ])

  return (
    <FlatList
      data={rows}
      keyExtractor={row => row.key}
      {...underBar}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl {...refresh} />}
      ListHeaderComponent={header}
      contentContainerStyle={styles.list}
      ListEmptyComponent={catalog.loading ? <View style={styles.center}><Spinner /></View>
        : <Text style={styles.note}>{catalog.error ? '应用加载失败' : needle ? `没有找到「${query.trim()}」` : catalog.data?.configured === false ? '应用商店未配置' : '没有应用'}</Text>}
      renderItem={({ item: row }) => 'title' in row ? <Text style={styles.section}>{row.title}</Text> : (
        <Pressable accessibilityRole="button" onPress={() => void open(row.item.id)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
          <AppIcon entry={row.item} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name} numberOfLines={1}>{row.item.name}</Text>
            {row.item.description ? <Text style={styles.detail} numberOfLines={1}>{row.item.description}</Text> : null}
          </View>
          {connected.has(row.item.id) ? <Text style={styles.state}>已连接</Text> : row.item.own ? null : <Text style={styles.connect}>连接</Text>}
          <Symbol name="chevron.right" size={13} color={colors.tertiary} />
        </Pressable>
      )}
    />
  )
}

function AppIcon({ entry }: { entry: Entry }) {
  if (entry.iconUrl) return <Image source={{ uri: entry.iconUrl }} style={styles.icon} />
  if (entry.id === 'github' || entry.id === 'linear') return <View style={styles.icon}><SourceIcon source={entry.id} size={28} /></View>
  return <View style={[styles.icon, styles.iconBlank]}><Symbol name="puzzlepiece.extension" size={16} color={colors.secondary} web={<Puzzle size={16} color={colors.secondary} />} /></View>
}

function Skills({ query, header }: { query: string; header: ReactElement }) {
  // skills.sh's leaderboard, or the search once typing pauses; a page at a time as the list scrolls.
  const [debounced, setDebounced] = useState(query.trim())
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(timer) }, [query])
  const [pages, setPages] = useState<SkillsPage[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const load = async (page: number) => {
    if (debounced.length === 1) { setPages([]); setLoading(false); return }
    setLoading(true)
    setFailed(false)
    const params = new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(page ? { page: String(page) } : {}) })
    try {
      const next = await api<SkillsPage>(`/api/skills/search${params.size ? `?${params}` : ''}`)
      setPages(current => page ? [...current, next] : [next])
    } catch { setFailed(true) } finally { setLoading(false) }
  }
  useEffect(() => { void load(0) }, [debounced])
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
      ListHeaderComponent={header}
      contentContainerStyle={styles.list}
      onEndReachedThreshold={0.6}
      onEndReached={() => { if (hasMore && !loading && !failed) void load(pages.length) }}
      ListFooterComponent={loading && skills.length ? <View style={styles.center}><Spinner /></View> : undefined}
      ListEmptyComponent={loading ? <View style={styles.center}><Spinner /></View>
        : <Text style={styles.note}>{failed ? '技能加载失败' : debounced.length === 1 ? '再多输入一个字' : `没有找到「${debounced}」`}</Text>}
      renderItem={({ item }) => (
        <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(item.url)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
          <View style={[styles.icon, styles.iconBlank]}><Symbol name="sparkles" size={16} color={colors.secondary} web={<Puzzle size={16} color={colors.secondary} />} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.detail} numberOfLines={1}>{item.source} · {item.installs.toLocaleString()} 次安装</Text>
          </View>
          <Symbol name="arrow.up.right" size={12} color={colors.tertiary} />
        </Pressable>
      )}
    />
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  header: { gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, borderRadius: 20, paddingHorizontal: 14, backgroundColor: colors.bubble },
  searchInput: { flex: 1, minWidth: 0, width: 0, height: 40, fontSize: 16, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  list: { paddingBottom: 32 },
  section: { fontSize: 13, color: colors.secondary, marginLeft: 20, marginTop: 18, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 20, paddingVertical: 8 },
  icon: { width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  iconBlank: { backgroundColor: colors.bubble },
  name: { fontSize: 16 },
  detail: { fontSize: 13, color: colors.secondary, marginTop: 2 },
  state: { fontSize: 14, color: colors.secondary },
  connect: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  center: { paddingVertical: 32, alignItems: 'center' },
  note: { textAlign: 'center', color: colors.secondary, marginTop: 32, fontSize: 15 },
})
