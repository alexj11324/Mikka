import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '@/components/ChatScreen'
import { useHome } from '@/lib/home'

/** A chat with one of the person's bots: same harness and screen as the Coordinator. */
export default function BotChat() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const bot = useHome().data?.bots.find(item => item.id === id)
  return <ChatScreen botId={id} name={bot?.name ?? ''} color={bot?.color} shape={bot?.shape} />
}
