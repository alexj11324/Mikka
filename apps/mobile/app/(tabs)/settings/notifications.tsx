import { View } from 'react-native'
import { SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'
import { PushRow } from '@/components/PushRow'
import { PreferenceSaveNotice } from '@/components/PreferenceSaveNotice'
import { mobileMessages as messages } from '@/lib/messages'
import { askForPush } from '@/lib/push-state'
import { useSettings } from '@/lib/settings'
import type { Preferences } from '@/lib/types'

/**
 * 通知 (07c): 主动消息 and which of the Coordinator's own messages reach the
 * phone; above them, whether pushes can reach it at all (PushRow). 待审阅 and 电脑不在用时 come back when the server tracks reviews and
 * whether the computer is in use.
 */
export default function NotificationsScreen() {
  const { data, savePreferences, preferenceSave } = useSettings()
  const title = messages.Settings.sections.notifications.title
  const copy = messages.Settings.notifications
  const p = data?.preferences
  if (!p) return <SettingsPage title={title}><View /></SettingsPage>
  // Turning a push on is the moment to ask iOS, if it has not been asked yet.
  const save = (patch: Partial<Preferences>) => {
    if (Object.values(patch).includes(true)) void askForPush()
    void savePreferences(patch)
  }
  return (
    <SettingsPage title={title}>
      <PushRow proactive={p.proactive} ask />
      <Group><ToggleRow label={copy.proactive} value={p.proactive} disabled={preferenceSave.status !== 'idle'} onChange={proactive => save({ proactive })} /></Group>
      {p.proactive ? (
        <Group label={messages.MobileCore.notifications.pushTypes}>
          <ToggleRow label={copy.pushDecide} value={p.pushDecide} disabled={preferenceSave.status !== 'idle'} onChange={pushDecide => save({ pushDecide })} />
          <ToggleRow label={copy.pushFinished} value={p.pushFinished} disabled={preferenceSave.status !== 'idle'} onChange={pushFinished => save({ pushFinished })} />
          <ToggleRow label={copy.pushBriefing} value={p.pushBriefing} disabled={preferenceSave.status !== 'idle'} onChange={pushBriefing => save({ pushBriefing })} />
        </Group>
      ) : null}
      <PreferenceSaveNotice />
    </SettingsPage>
  )
}
