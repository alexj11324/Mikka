import { useRouter } from 'expo-router'
import { Group } from '@/components/ui'
import { Row } from '@/components/settings'
import { ReadNotice } from '@/components/ReadNotice'
import { listRef } from '@/lib/live'
import { mobileMessages } from '@/lib/messages'
import { useLiveApi } from '@/lib/useApi'
import type { ConversationDirectoryPage } from '../../../../../lib/conversation-directory-input'
import { pullRequestsState } from '../../../../../lib/directory-pulls'

type Children = Pick<ConversationDirectoryPage, 'items'> & { workspaceId: string; botId: string; more: boolean }
const labels = mobileMessages.ConversationDirectory

export function BotConversations({ workspaceId, botId }: { workspaceId?: string; botId?: string }) {
  const router = useRouter()
  const path = workspaceId && botId ? '/api/mobile/conversations?' + new URLSearchParams({ view: 'botChildren', workspaceId, botId }) : null
  const read = useLiveApi<Children>(path, () => ({ refs: [listRef('thread_list', workspaceId), listRef('group_list', workspaceId)], minIntervalMs: 2_000 }))
  const data = read.data
  const group = path && data && data.workspaceId === workspaceId && data.botId === botId ? data : null
  return <>
    <ReadNotice error={read.error} hasData={Boolean(group)} label={labels.title} onRetry={read.reload} />
    {group?.items.length ? <Group label={labels.title}>
      {group.items.map(item => {
        const pullState = item.pulls?.length ? mobileMessages.Metadata.prState[pullRequestsState(item.pulls)] : null
        return <Row key={item.id} label={item.title || labels.untitled} detail={[labels[item.state], pullState].filter(Boolean).join(' · ')}
          value={item.unread ? labels.unread : undefined} onPress={() => router.push(item.kind === 'chat' ? `/groups/${item.id}` : `/thread/${item.id}`)} />
      })}
      {group.more && <Row label={labels.viewAll} onPress={() => router.push({ pathname: '/conversations', params: { workspaceId: group.workspaceId, botId: group.botId } })} />}
    </Group> : null}
  </>
}
