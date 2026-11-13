import { useRef, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { GlassButton } from '@/components/GlassButton'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Row } from '@/components/settings'
import { Segmented } from '@/components/Segmented'
import { Text } from '@/components/Text'
import { api, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { withholdsCachedRead } from '@/lib/api-read-state'
import { useHome } from '@/lib/home'
import { listRef } from '@/lib/live'
import { mobileLocale, mobileMessages } from '@/lib/messages'
import { colors, LIST_INSET } from '@/lib/theme'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { useTaskContinuation } from '../../../lib/hooks/use-task-continuation'
import type { conversationDirectory } from '../../../lib/conversation-directory'
import type { DirectoryInput } from '../../../lib/conversation-directory-input'

type Page = Awaited<ReturnType<typeof conversationDirectory>> & { workspaceId: string }
const labels = mobileMessages.ConversationDirectory
const states = ['all', 'working', 'waiting', 'idle', 'failed'] as const

export default function Conversations() {
  const router = useRouter()
  const { botId } = useLocalSearchParams<{ botId?: string }>()
  const workspaceId = useHome().data?.workspace.id
  const [search, setSearch] = useState('')
  const [state, setState] = useState<NonNullable<DirectoryInput['state']>>('all')
  const [archived, setArchived] = useState(false)
  const [writing, setWriting] = useState(false)
  const [writeError, setWriteError] = useState(false)
  const pending = useRef(false)
  const params = new URLSearchParams({ workspaceId: workspaceId ?? '', search, state, archived: String(archived) })
  if (botId) params.set('botId', botId)
  const path = workspaceId ? '/api/mobile/conversations?' + params : null
  const list = useLiveApi<Page>(path, () => ({ refs: [listRef('thread_list', workspaceId)], minIntervalMs: 2_000 }))
  const page = list.data?.workspaceId === workspaceId ? list.data : null
  const pages = useTaskContinuation(page?.items ?? [], page, page?.cursor ?? null, async cursor => {
    const context = apiCache.context()
    const revision = path && apiCache.revision(path)
    const next = new URLSearchParams(params)
    next.set('after', cursor.id)
    next.set('at', cursor.at)
    next.set('pinned', String(cursor.pinned))
    const result = await api<Page>('/api/mobile/conversations?' + next).catch(error => {
      if (path && error instanceof ApiError && withholdsCachedRead(error.status) && revision === apiCache.revision(path)) {
        apiCache.revoke(path, context, error)
      }
      throw error
    })
    if (result.workspaceId !== workspaceId) throw new Error('workspaceAccessDenied')
    return { items: result.items, next: result.cursor }
  })
  const refresh = useRefresh(list.reload)
  async function mark(runId?: string) {
    if (pending.current || !workspaceId) return
    pending.current = true
    setWriting(true)
    setWriteError(false)
    try {
      await api('/api/conversations/read-state', { method: 'POST', body: runId ? { action: 'unread', runId } : { action: 'readAll' } })
      await list.reload()
    } catch { setWriteError(true) }
    finally { pending.current = false; setWriting(false) }
  }
  return <View style={styles.screen}>
    <NavBar title={labels.title} back={() => router.back()} search={{ placeholder: labels.search, onChange: value => setSearch(value.slice(0, 120)) }} />
    <FlatList {...underBar} data={pages.items} keyExtractor={item => item.id} refreshControl={<RefreshControl {...refresh} />}
      ListHeaderComponent={<View style={styles.controls}>
        <Segmented options={states.map(value => ({ value, label: labels[value] }))} value={state} onChange={setState} />
        <Row label={labels.archived} value={archived ? '✓' : undefined} onPress={() => setArchived(!archived)} />
        <GlassButton label={labels.readAll} busy={writing} disabled={!page} onPress={() => void mark()} />
        {writeError && <Text accessibilityRole="alert">{labels.writeError}</Text>}
        <ReadNotice error={list.error} label={labels.title} hasData={Boolean(page)} onRetry={list.reload} />
      </View>}
      renderItem={({ item }) => <View>
        <Row label={item.title || labels.untitled} value={item.unread ? labels.unread : undefined}
          detail={[labels[item.state], item.identifier, new Date(item.at).toLocaleString(mobileLocale)].filter(Boolean).join(' · ')}
          onPress={() => router.push(`/thread/${item.id}`)} />
        {!item.unread && <View style={styles.action}><GlassButton label={labels.markUnread} disabled={writing} onPress={() => void mark(item.id)} /></View>}
      </View>}
      ListEmptyComponent={!list.error ? <Text style={styles.action}>{list.loading || !workspaceId ? labels.loading : labels.empty}</Text> : null}
      ListFooterComponent={pages.hasMore ? <View style={styles.action}><GlassButton label={pages.failed ? labels.retry : labels.more}
        busy={pages.loading} onPress={() => void pages.loadMore()} /></View> : null} />
  </View>
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  controls: { gap: 12, padding: LIST_INSET },
  action: { alignSelf: 'flex-start', marginHorizontal: LIST_INSET, marginBottom: 12 },
})
