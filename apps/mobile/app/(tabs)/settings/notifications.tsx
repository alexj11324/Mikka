import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { Row, SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'
import { Spinner } from '@/components/icons'
import { ReadNotice } from '@/components/ReadNotice'
import { PushRow } from '@/components/PushRow'
import { PreferenceSaveNotice } from '@/components/PreferenceSaveNotice'
import { mobileLocale, mobileMessages as messages } from '@/lib/messages'
import { ApiError } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { askForPush, usePushState } from '@/lib/push-state'
import { useSettings } from '@/lib/settings'
import type { Preferences } from '@/lib/types'

type PushInstallation = { id: string; platform: 'ios' | 'android'; deviceName: string | null; currentSession: boolean; updatedAt: string }

function PushDevices() {
  const copy = messages.MobileCore.notifications
  const { data, error, loading, reload, reloadAfterWrite } = useApi<{ installations: PushInstallation[] }>('/api/mobile/push-tokens')
  const registration = usePushState()
  const previous = useRef(registration)
  useEffect(() => {
    if (registration === 'registered' && previous.current !== registration) void reloadAfterWrite()
    previous.current = registration
  }, [registration, reloadAfterWrite])

  // Older servers support registration but do not expose the directory.
  if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return null
  return <Group label={copy.registeredDevices}>
    <ReadNotice error={error} hasData={Boolean(data)} label={copy.registeredDevices} onRetry={reload} />
    {!data && loading ? <Spinner /> : null}
    {data?.installations.length === 0 ? <Row label={copy.noRegisteredDevices} /> : null}
    {data?.installations.map(device => {
      const platform = device.platform === 'ios' ? 'iOS' : 'Android'
      const date = new Date(device.updatedAt).toLocaleDateString(mobileLocale)
      return <Row key={device.id} label={device.deviceName || platform} detail={device.deviceName ? `${platform} · ${date}` : date}
        value={device.currentSession ? messages.Settings.profile.currentSession : undefined} />
    })}
  </Group>
}

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
      {typeof p.organizationInvitationEmails === 'boolean' ? <Group>
        <ToggleRow label={copy.organizationInvitationEmails} value={p.organizationInvitationEmails} disabled={preferenceSave.status !== 'idle'} onChange={organizationInvitationEmails => { void savePreferences({ organizationInvitationEmails }) }} />
      </Group> : null}
      <PreferenceSaveNotice />
      <PushDevices />
    </SettingsPage>
  )
}
