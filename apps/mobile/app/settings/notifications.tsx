import { View } from 'react-native'
import { SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'
import { PushRow } from '@/components/PushRow'
import { askForPush } from '@/lib/push-state'
import { useSettings } from '@/lib/settings'
import type { Preferences } from '@/lib/types'

/**
 * 通知 (07c): 主动消息 and which of the Coordinator's own messages reach the
 * phone; above them, whether pushes can reach it at all (PushRow). 待审阅 and 电脑不在用时 come back when the server tracks reviews and
 * whether the computer is in use.
 */
export default function NotificationsScreen() {
  const { data, savePreferences } = useSettings()
  const p = data?.preferences
  if (!p) return <SettingsPage title="通知"><View /></SettingsPage>
  // Turning a push on is the moment to ask iOS, if it has not been asked yet.
  const save = (patch: Partial<Preferences>) => {
    if (Object.values(patch).includes(true)) void askForPush()
    void savePreferences(patch)
  }
  return (
    <SettingsPage title="通知">
      <PushRow proactive={p.proactive} ask />
      <Group><ToggleRow label="主动消息" value={p.proactive} onChange={proactive => save({ proactive })} /></Group>
      {p.proactive ? (
        <Group label="推送这些事">
          <ToggleRow label="需要你决策" value={p.pushDecide} onChange={pushDecide => save({ pushDecide })} />
          <ToggleRow label="线程完成" value={p.pushFinished} onChange={pushFinished => save({ pushFinished })} />
          <ToggleRow label="每日简报" value={p.pushBriefing} onChange={pushBriefing => save({ pushBriefing })} />
        </Group>
      ) : null}
    </SettingsPage>
  )
}
