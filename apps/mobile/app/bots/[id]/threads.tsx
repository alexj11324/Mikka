import { useLocalSearchParams } from 'expo-router'
import { ThreadsScreen } from '@/components/ThreadsScreen'
import { useHome } from '@/lib/home'

/** One bot's threads, pushed over its chat (back returns to it). */
export default function BotThreads() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const bot = useHome().data?.bots.find(item => item.id === id)
  return <ThreadsScreen bot={id === 'coordinator' ? undefined : bot?.name} />
}
