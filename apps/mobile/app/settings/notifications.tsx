import { View } from 'react-native'
import { SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'
import { useSettings } from '@/lib/settings'

/**
 * 通知 (07c): 主动消息 and which of the Coordinator's own messages reach the
 * phone. 待审阅, 每日简报 and 电脑不在用时 come back when the server sends
 * those (the attention and briefing work).
 */
export default function NotificationsScreen() {
  const { data, savePreferences } = useSettings()
  const p = data?.preferences
  if (!p) return <SettingsPage title="通知"><View /></SettingsPage>
  return (
    <SettingsPage title="通知">
      <Group><ToggleRow label="主动消息" value={p.proactive} onChange={proactive => void savePreferences({ proactive })} /></Group>
      {p.proactive ? (
        <Group label="推送这些事">
          <ToggleRow label="需要你决策" value={p.pushDecide} onChange={pushDecide => void savePreferences({ pushDecide })} />
          <ToggleRow label="线程完成" value={p.pushFinished} onChange={pushFinished => void savePreferences({ pushFinished })} />
        </Group>
      ) : null}
    </SettingsPage>
  )
}
