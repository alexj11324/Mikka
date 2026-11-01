import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '@/components/ChatScreen'
import { useHome } from '@/lib/home'

/**
 * A chat with a bot; `coordinator` is the Coordinator's (R-06: an ordinary
 * chat). `draft` comes from a 建议 item, `compose` from 新线程 (the keyboard
 * opens), `action` from a push about a proposal (its card is marked).
 */
export default function BotChat() {
  const { id, action, draft, compose } = useLocalSearchParams<{ id: string; action?: string; draft?: string; compose?: string }>()
  const bot = useHome().data?.bots.find(item => item.id === id)
  if (id === 'coordinator') return <ChatScreen botId={null} name="Coordinator" draft={draft} focus={action} compose={compose === '1'} />
  return <ChatScreen botId={id} name={bot?.name ?? ''} color={bot?.color} shape={bot?.shape} draft={draft} focus={action} compose={compose === '1'} />
}
