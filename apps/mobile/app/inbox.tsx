import { useRef, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { GlassButton } from '@/components/GlassButton'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Segmented } from '@/components/Segmented'
import { Row } from '@/components/settings'
import { Text } from '@/components/Text'
import { api, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { withholdsCachedRead } from '@/lib/api-read-state'
import { useHome } from '@/lib/home'
import { inboxLive } from '@/lib/live-keys'
import { mobileMessages } from '@/lib/messages'
import { colors, LIST_INSET } from '@/lib/theme'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { useTaskContinuation } from '../../../lib/hooks/use-task-continuation'
import type { InboxEntry, InboxPage } from '../../../lib/inbox/contract'

const labels = mobileMessages.HostedInbox
type Tab = InboxEntry['status']
type Page = InboxPage & { live?: { workspaceId: string } }
const tabs = [
  { value: 'pending' as const, label: labels.waitingOnYou },
  { value: 'snoozed' as const, label: labels.snoozed },
  { value: 'done' as const, label: labels.done },
]
const historyRow = (entry: InboxEntry) => ({ id: entry.completion?.id ?? entry.type + ':' + entry.id, entry })

export default function Inbox() {
  const router = useRouter()
  const workspace = useHome().data?.workspace.id
  const [tab, setTab] = useState<Tab>('pending')
  const path = workspace ? '/api/inbox?' + new URLSearchParams({ workspaceId: workspace, tab }) : null
  const list = useLiveApi<Page>(path, () => inboxLive(workspace))
  const page = list.data?.live?.workspaceId === workspace ? list.data : null
  const pages = useTaskContinuation(page?.items.map(historyRow) ?? [], page, page?.nextCursor ?? null, async cursor => {
    const context = apiCache.context()
    const revision = path && apiCache.revision(path)
    const next = await api<Page>(path + '&cursor=' + encodeURIComponent(cursor)).catch(error => {
      if (path && error instanceof ApiError && withholdsCachedRead(error.status) && apiCache.revision(path) === revision) {
        apiCache.revoke(path, context, error)
      }
      throw error
    })
    if (next.live?.workspaceId !== workspace) throw new Error('workspaceAccessDenied')
    return { items: next.items.map(historyRow), next: next.nextCursor }
  })
  const refresh = useRefresh(list.reload)
  const pending = useRef(false)
  const [writing, setWriting] = useState(false)
  const [failedAt, setFailedAt] = useState<{ path: string; context: number } | null>(null)
  async function change(entry: InboxEntry, action: 'dismiss' | 'reopen') {
    if (!workspace || !path || pending.current || !entry.actions.includes(action)) return
    const context = apiCache.context()
    pending.current = true
    setWriting(true)
    setFailedAt(null)
    try {
      const response = await api<{ changed: boolean }>('/api/inbox', { method: 'POST', body: { workspaceId: workspace, type: entry.type, id: entry.id, action } })
      if (typeof response?.changed !== 'boolean') throw new Error('decisionUnconfirmed')
      if (apiCache.context() === context) await list.reloadAfterWrite()
    } catch {
      if (apiCache.context() === context) {
        setFailedAt({ path, context })
        await list.reloadAfterWrite()
      }
    } finally { pending.current = false; setWriting(false) }
  }
  const open = (entry: InboxEntry) => entry.type === 'suggestion' ? router.push('/suggestions')
    : entry.type === 'conversation' ? router.push(`/thread/${entry.id}`) : router.push(`/task/${entry.id}`)
  return <View style={styles.screen}>
    <NavBar title={mobileMessages.Nav.inbox} back={() => router.back()} />
    <FlatList {...underBar} data={pages.items} keyExtractor={row => row.id} refreshControl={<RefreshControl {...refresh} />}
      ListHeaderComponent={<View style={styles.controls}>
        <Segmented options={tabs} value={tab} onChange={setTab} />
        <ReadNotice error={list.error} hasData={Boolean(page)} label={mobileMessages.Nav.inbox} onRetry={list.reload} />
        {failedAt && failedAt.context === apiCache.context() && failedAt.path === path && <Text accessibilityRole="alert">{labels.writeError}</Text>}
      </View>}
      renderItem={({ item: { entry } }) => <View>
        <Row label={entry.title || mobileMessages.ConversationDirectory.untitled}
          detail={entry.reason ? labels.reason[entry.reason] : entry.type === 'suggestion' ? labels.suggestion : undefined}
          onPress={() => open(entry)} />
        {(['dismiss', 'reopen'] as const).filter(action => entry.actions.includes(action)).map(action =>
          <View key={action} style={styles.action}><GlassButton label={labels[action]} disabled={writing} onPress={() => void change(entry, action)} /></View>)}
      </View>}
      ListEmptyComponent={!list.error ? <Text style={styles.action}>{!page ? mobileMessages.Common.loading
        : tab === 'done' ? labels.emptyDone : tab === 'snoozed' ? labels.emptySnoozed : labels.emptyPending}</Text> : undefined}
      ListFooterComponent={pages.hasMore ? <View style={styles.action}><GlassButton busy={pages.loading}
        label={pages.failed ? mobileMessages.Common.retry : labels.more} onPress={() => void pages.loadMore()} /></View> : undefined} />
  </View>
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  controls: { padding: LIST_INSET, gap: 8 },
  action: { alignSelf: 'flex-start', marginHorizontal: LIST_INSET, marginVertical: 8 },
})
