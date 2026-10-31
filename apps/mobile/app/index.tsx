import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '@/components/ChatScreen'

/**
 * The Coordinator chat, the app's home (mobile.md). `draft` comes from a 建议
 * row: the composer opens with it, as the web fills the Coordinator's composer.
 * `action` comes from a push about a proposal: its card is marked.
 */
export default function CoordinatorScreen() {
  const { draft, action, compose } = useLocalSearchParams<{ draft?: string; action?: string; compose?: string }>()
  return <ChatScreen botId={null} name="Coordinator" draft={draft} focus={action} compose={compose === '1'} />
}
