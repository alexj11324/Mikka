import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '@/components/ChatScreen'

/**
 * The Coordinator chat, the app's home (mobile.md). `draft` comes from a 建议
 * row: the composer opens with it, as the web fills the Coordinator's composer.
 */
export default function CoordinatorScreen() {
  const { draft } = useLocalSearchParams<{ draft?: string }>()
  return <ChatScreen botId={null} name="Coordinator" draft={draft} />
}
