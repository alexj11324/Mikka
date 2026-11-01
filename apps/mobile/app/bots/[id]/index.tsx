import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '@/components/ChatScreen'
import { ModelMenu } from '@/components/ModelMenu'
import { useHome } from '@/lib/home'

/**
 * A chat with a bot; `coordinator` is the Coordinator's (R-06: an ordinary
 * chat). `draft` comes from a 建议 item, `compose` from 新线程 (the keyboard
 * opens), `action` from a push about a proposal (its card is marked). The
 * composer carries the bot's model menu (decision 2026-10-31-2330).
 */
export default function BotChat() {
  const { id, action, draft, compose } = useLocalSearchParams<{ id: string; action?: string; draft?: string; compose?: string }>()
  const bot = useHome().data?.bots.find(item => item.id === id)
  if (id === 'coordinator') return <ChatScreen botId={null} name="Coordinator" draft={draft} focus={action} compose={compose === '1'} composerAccessory={<ModelMenu botId={null} />} />
  return <ChatScreen botId={id} name={bot?.name ?? ''} color={bot?.color} shape={bot?.shape} draft={draft} focus={action} compose={compose === '1'} composerAccessory={<ModelMenu botId={id} />} />
}
