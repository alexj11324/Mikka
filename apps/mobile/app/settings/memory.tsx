import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { Row, SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'
import { useSettings } from '@/lib/settings'

/** 记忆 (ChatGPT, Claude): the switch, and the summary as one Markdown document. */
export default function MemoryScreen() {
  const router = useRouter()
  const { data, savePreferences } = useSettings()
  if (!data) return <SettingsPage title="记忆"><View /></SettingsPage>
  return (
    <SettingsPage title="记忆">
      <Group><ToggleRow label="使用记忆" value={data.preferences.memoryEnabled} onChange={memoryEnabled => void savePreferences({ memoryEnabled })} /></Group>
      <Group><Row label="记忆摘要" onPress={() => router.push('/settings/memory-summary')} /></Group>
    </SettingsPage>
  )
}
