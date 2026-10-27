import { useState } from 'react'
import { useRouter } from 'expo-router'
import { Row, SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'

/** 记忆 (ChatGPT, Claude): the switch, and the summary as one Markdown document. */
export default function MemoryScreen() {
  const router = useRouter()
  const [on, setOn] = useState(true)
  return (
    <SettingsPage title="记忆">
      <Group><ToggleRow label="使用记忆" value={on} onChange={setOn} /></Group>
      <Group><Row label="记忆摘要" detail="更新于 12 分钟前" onPress={() => router.push('/settings/memory-summary')} /></Group>
    </SettingsPage>
  )
}
