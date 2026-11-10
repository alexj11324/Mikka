import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '@/features/chat/screens/chat-screen'
import { ModelMenu } from '@/components/ModelMenu'
import { ModelNotice } from '@/components/ModelNotice'
import { useHome } from '@/lib/home'
import { useModelMenu } from '@/lib/model-menu'

/**
 * A chat with a bot; `coordinator` is the Coordinator's (R-06: an ordinary
 * chat). `draft` comes from a 建议 item, `compose` from 新线程 (the keyboard
 * opens), `action` from a push about a proposal (its card is marked). The
 * composer carries the bot's model menu (decision 2026-10-31-2330).
 */
export default function BotChat() {
  const { id, action, draft, compose,taskRequest } = useLocalSearchParams<{ id: string; action?: string; draft?: string; compose?: string;taskRequest?:string }>()
  const bot = useHome().data?.bots.find(item => item.id === id)
  const coordinator = id === 'coordinator'
  const model = useModelMenu(coordinator ? null : id)
  const composer = { composerAccessory: (running: boolean) => <ModelMenu model={model} running={running} />, composerNotice: <ModelNotice model={model} /> }
  if (coordinator) return <ChatScreen botId={null} name="Coordinator" draft={draft} focus={action} compose={compose === '1'} taskRequest={taskRequest==='1'} {...composer} />
  return <ChatScreen botId={id} name={bot?.name ?? ''} color={bot?.color} shape={bot?.shape} draft={draft} focus={action} compose={compose === '1'} {...composer} />
}
