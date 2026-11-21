import { ReadNotice } from '@/components/ReadNotice'
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useCallback, useRef } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Puzzle, Sparkles } from 'lucide-react-native'
import { SourceIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { shortWhen } from '@/lib/clock'
import type { Suggestion, Suggestions } from '@/lib/types'
import { openChat } from '@/lib/navigate'
import { api, apiConnection } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { mobileMessages } from '@/lib/messages'
import { handoffSuggestion } from '@/lib/suggestion-handoff'
import { useDecisionSubmission } from '../../../../../hooks/use-decision-submission'
import { useApi, useRefresh } from '@/lib/useApi'
import { colors, LIST_INSET, ROW_SURFACE_INSET } from '@/lib/theme'
import { ListSectionHeader } from '@/shared/components/list-section'
import { EmptyState, ListLoading } from '@/shared/components/empty-state'

const VERB: Record<string, string> = mobileMessages.SuggestionsPage.action
const APP: Record<string, string> = mobileMessages.Shell.suggestions.source
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
/** One and many are two keys, as thread-steps.ts does: the phone has no ICU formatter. */
const counted = (count: number) => (count === 1 ? mobileMessages.MobileCore.item : mobileMessages.MobileCore.items).replace('{count}', String(count))

/**
 * 建议 (Comma design 16): a row of cards, one per app with today's count, then today's items, each led by its app's
 * icon and a verb (R-21, R-45). Tapping one hands it to the Coordinator, as on the web. 插件 is the bar button.
 */
export default function SuggestionsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { data, error, loading, reload, setData } = useApi<Suggestions>(`/api/suggestions?tz=${encodeURIComponent(timeZone)}`)
  const refresh = useRefresh(reload)
  const delivery = useDecisionSubmission()
  const context = apiCache.context()
  const focus = useRef(0)
  useFocusEffect(useCallback(() => {
    focus.current++
    return () => { focus.current++ }
  }, []))
  const groups = (data?.groups ?? []).filter(group => group.items.length)
  const items = groups.flatMap(group => group.items).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  const key = (id: string) => `${context}:${id}`
  const submitting = () => items.some(item => delivery.state(key(item.id)).status === 'submitting')
  const anyPending = submitting()
  async function arrange(item: Suggestion) {
    if (submitting() || context !== apiCache.context()) return
    const connection = apiConnection(), visit = focus.current
    const accepted = await delivery.submit(key(item.id), () =>
      handoffSuggestion(item.id, (path, init) => api(path, init, connection)), 'decisionUnconfirmed')
    if (!accepted || context !== apiCache.context()) return
    setData(current => current && ({
      ...current, groups: current.groups.map(group => ({ ...group, items: group.items.filter(row => row.id !== item.id) })),
    }))
    void reload()
    if (visit === focus.current) openChat({ pathname: '/bots/[id]', params: { id: 'coordinator' } })
  }

  return (
    <View style={styles.screen}>
      <NavBar title={mobileMessages.Nav.suggestions} topTitle
        right={{ icon: 'puzzlepiece.extension', label: mobileMessages.Nav.plugins, web: <Puzzle size={20} color={colors.ink} strokeWidth={2} />, onPress: () => router.push('/suggestions/plugins') }} />
      <FlatList
        data={items}
        keyExtractor={item => item.id}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        ListHeaderComponent={<>
          {loading ? <ListLoading /> : null}
          <ReadNotice error={error} hasData={Boolean(data)} label={mobileMessages.Nav.suggestions} onRetry={reload} />
          {groups.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cards}>
              {groups.map(group => (
                <View key={group.source} style={styles.card} accessible accessibilityLabel={mobileMessages.Common.propertyValue.replace('{label}', APP[group.source] ?? group.source).replace('{value}', counted(group.items.length))}>
                  <View style={styles.cardHead}>
                    <View style={styles.badge}><SourceIcon source={group.source} size={16} /></View>
                    <Text style={styles.cardName} numberOfLines={1}>{APP[group.source] ?? group.source}</Text>
                  </View>
                  <Text style={styles.cardCount}>{counted(group.items.length)}</Text>
                </View>
              ))}
            </ScrollView>
          ) : null}
          {items.length ? <ListSectionHeader title={mobileMessages.AgentCopy.today} /> : null}
          {!loading && !error && data && !items.length ? <EmptyState icon={<Sparkles size={20} color={colors.secondary} strokeWidth={1.8} />} title={mobileMessages.Shell.suggestions.noneToday} /> : null}
        </>}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        renderItem={({ item }) => {
          const state = delivery.state(key(item.id))
          const pending = state.status === 'submitting'
          const disabled = anyPending || state.status === 'unavailable' || state.status === 'accepted'
          const errorText = 'error' in state ? mobileMessages.Errors[state.error as keyof typeof mobileMessages.Errors] : null
          const message = typeof errorText === 'string' ? errorText : 'error' in state ? mobileMessages.Errors.generic : null
          return <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ busy: pending, disabled }} onPress={() => { void arrange(item) }} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
            <View style={styles.badge}><SourceIcon source={item.source} size={16} /></View>
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={2}>{VERB[item.action] ? <Text style={styles.verb}>{VERB[item.action]} </Text> : null}{item.title}</Text>
              <Text style={styles.meta} numberOfLines={1}>{[APP[item.source] ?? item.source, item.actor, shortWhen(item.occurredAt)].filter(Boolean).join(' · ')}</Text>
              {pending && <Text accessibilityLiveRegion="polite" style={styles.meta}>{mobileMessages.HostedThread.sending}</Text>}
              {message && <Text accessibilityRole="alert" style={styles.failure}>{message}{state.status === 'unavailable' ? '' : ' · ' + mobileMessages.Common.retry}</Text>}
            </View>
          </Pressable>
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  cards: { paddingHorizontal: LIST_INSET, paddingTop: 4, paddingBottom: 4, gap: 10 },
  card: { width: 168, gap: 10, padding: 12, borderRadius: 16, borderCurve: 'continuous', backgroundColor: colors.bubble },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardName: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
  cardCount: { fontSize: 13, color: colors.secondary },
  badge: { width: 26, height: 26, borderRadius: 7, borderCurve: 'continuous', backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: ROW_SURFACE_INSET, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET, paddingVertical: 9, borderRadius: 10 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  failure: { color: colors.danger, fontSize: 14 },
  title: { fontSize: 17, lineHeight: 22 },
  verb: { fontWeight: '600' },
  meta: { fontSize: 13, lineHeight: 18, color: colors.secondary },
})
