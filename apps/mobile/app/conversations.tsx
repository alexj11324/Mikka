import { useRef, useState } from 'react'
import { FlatList, Linking, RefreshControl, StyleSheet, View } from 'react-native'
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
import { directoryPullRequests, directoryPullStates, pullRequestsState } from '../../../lib/directory-pulls'
import type { ConversationDirectoryPage, DirectoryInput } from '../../../lib/conversation-directory-input'

type Page = ConversationDirectoryPage & { workspaceId: string }
const labels = mobileMessages.ConversationDirectory
const states = ['all', 'working', 'waiting', 'idle', 'failed'] as const

export default function Conversations() {
  const router = useRouter()
  const { botId, workspaceId: linkedWorkspace, view } = useLocalSearchParams<{ botId?: string; workspaceId?: string; view?: string }>()
  const pullsOnly = view === 'pulls'
  const title = pullsOnly ? mobileMessages.ArtifactsPage.category.pullRequests : labels.title
  const [pullState, setPullState] = useState<typeof directoryPullStates[number]>('all')
  const workspaceId = useHome().data?.workspace.id
  const [search, setSearch] = useState('')
  const [state, setState] = useState<NonNullable<DirectoryInput['state']>>('all')
  const [archived, setArchived] = useState(false)
  const [writing, setWriting] = useState(false)
  const [writeError, setWriteError] = useState(false)
  const pending = useRef(false)
  const params = new URLSearchParams({ workspaceId: linkedWorkspace ?? workspaceId ?? '', search, state: pullsOnly ? 'all' : state, archived: pullsOnly ? 'any' : String(archived),
    pullState: pullsOnly && pullState === 'all' ? 'linked' : pullState })
  if (botId) params.set('botId', botId)
  const path = workspaceId ? '/api/mobile/conversations?' + params : null
  const list = useLiveApi<Page>(path, () => ({ refs: [listRef('thread_list', workspaceId), listRef('group_list', workspaceId)], minIntervalMs: 2_000 }))
  const page = list.data?.workspaceId === workspaceId && (!linkedWorkspace || linkedWorkspace === workspaceId) ? list.data : null
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
  async function mark(body: { action: 'unread'; runId: string } | { action: 'unread'; chatId: string } | { action: 'readAll' }) {
    if (pending.current || !workspaceId) return
    pending.current = true
    setWriting(true)
    setWriteError(false)
    try {
      await api('/api/conversations/read-state', { method: 'POST', body })
      await list.reload()
    } catch { setWriteError(true) }
    finally { pending.current = false; setWriting(false) }
  }
  type Conversation = Page['items'][number]
  const open = (row: Conversation) => router.push(row.kind === 'chat' ? `/groups/${row.id}` : `/thread/${row.id}`)
  const rows = pullsOnly
    ? directoryPullRequests(pages.items, pullState).map(entry => ({ kind: 'pull' as const, key: entry.pull.url, ...entry }))
    : pages.items.map(conversation => ({ kind: 'conversation' as const, key: conversation.id, conversation }))
  return <View style={styles.screen}>
    <NavBar title={title} back={() => router.back()} search={{ placeholder: labels.search, onChange: value => setSearch(value.slice(0, 120)) }} />
    <FlatList<(typeof rows)[number]> {...underBar} data={rows} keyExtractor={item => item.key} refreshControl={<RefreshControl {...refresh} />}
      ListHeaderComponent={<View style={styles.controls}>
        {!pullsOnly && <Segmented options={states.map(value => ({ value, label: labels[value] }))} value={state} onChange={setState} />}
        <Segmented options={directoryPullStates.map(value => ({ value, label: value === 'all' ? mobileMessages.ArtifactsPage.category.pullRequests : mobileMessages.Metadata.prState[value] }))} value={pullState} onChange={setPullState} />
        {!pullsOnly && <Row label={labels.archiveIdle} onPress={() => router.push('/settings/conversations')} />}
        {!pullsOnly && <Row label={labels.archived} value={archived ? '✓' : undefined} onPress={() => setArchived(!archived)} />}
        {!pullsOnly && <GlassButton label={labels.readAll} busy={writing} disabled={!page} onPress={() => void mark({ action: 'readAll' })} />}
        {writeError && <Text accessibilityRole="alert">{labels.writeError}</Text>}
        <ReadNotice error={list.error} label={title} hasData={Boolean(page)} onRetry={list.reload} />
      </View>}
      renderItem={({ item: row }) => {
        if (row.kind === 'pull') {
          const { pull, conversations } = row
          const tasks = new Map(conversations.flatMap(item => item.issueId ? [[item.issueId, item.identifier || item.taskTitle || item.issueId] as const] : []))
          const counts = pull.additions !== undefined && pull.deletions !== undefined ? `+${pull.additions} −${pull.deletions}` : null
          return <View>
            <Row label={pull.title || pull.url} detail={[mobileMessages.Metadata.prState[pull.state], counts].filter(Boolean).join(' · ')}
              onPress={() => { void Linking.openURL(pull.url) }} />
            {conversations.map(item => <Row key={item.id} label={item.title || labels.untitled} onPress={() => open(item)} />)}
            {[...tasks].map(([id, label]) => <Row key={id} label={label} onPress={() => router.push(`/task/${id}`)} />)}
          </View>
        }
        const item = row.conversation
        const prStatus = item.pulls?.length ? mobileMessages.Metadata.prState[pullRequestsState(item.pulls)] : null
        return <View>
          <Row label={item.title || labels.untitled} value={item.unread ? labels.unread : undefined}
            detail={[labels[item.state], prStatus, item.identifier, new Date(item.at).toLocaleString(mobileLocale)].filter(Boolean).join(' · ')}
            onPress={() => open(item)} />
          {!item.unread && <View style={styles.action}><GlassButton label={labels.markUnread} disabled={writing} onPress={() => void mark(item.kind === 'chat' ? { action: 'unread', chatId: item.id } : { action: 'unread', runId: item.id })} /></View>}
        </View>
      }}
      ListEmptyComponent={!list.error ? <Text style={styles.action}>{list.loading || !workspaceId ? labels.loading : labels.empty}</Text> : undefined}
      ListFooterComponent={pages.hasMore ? <View style={styles.action}><GlassButton label={pages.failed ? labels.retry : labels.more}
        busy={pages.loading} onPress={() => void pages.loadMore()} /></View> : undefined} />
  </View>
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  controls: { gap: 12, padding: LIST_INSET },
  action: { alignSelf: 'flex-start', marginHorizontal: LIST_INSET, marginBottom: 12 },
})
