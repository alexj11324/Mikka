import { useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { colors, font } from '@/lib/theme'
import { Row, SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'
import { Spinner } from '@/components/icons'
import { ReadNotice } from '@/components/ReadNotice'
import { PushRow } from '@/components/PushRow'
import { PreferenceSaveNotice } from '@/components/PreferenceSaveNotice'
import { mobileLocale, mobileMessages as messages } from '@/lib/messages'
import { api, apiConnection, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { useApi } from '@/lib/useApi'
import { askForPush, usePushState } from '@/lib/push-state'
import { useSettings } from '@/lib/settings'
import type { Preferences } from '@/lib/types'

type PushInstallation = { id: string; platform: 'ios' | 'android'; deviceName: string | null; label?: string | null; canRename?: boolean; currentSession: boolean; canTest?: boolean; updatedAt: string }

function DeviceLabel({ device, reload }: { device: PushInstallation; reload: () => Promise<unknown> }) {
  const copy = messages.MobileCore.notifications
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle')
  const inFlight = useRef(false)
  const context = apiCache.context()
  const label = draft?.trim()
  async function save() {
    if (!label || label.length > 80 || inFlight.current || apiCache.context() !== context) return
    inFlight.current = true
    setStatus('saving')
    try {
      const result = await api<{ id: string; label: string }>('/api/mobile/push-tokens/' + encodeURIComponent(device.id),
        { method: 'PATCH', body: { label } }, apiConnection())
      if (result?.id !== device.id || result.label !== label) throw new Error('unexpected installation')
      apiCache.commit(context, () => { setStatus('idle'); setDraft(null); void reload() })
    } catch (error) {
      apiCache.commit(context, () => {
        setStatus('failed')
        if (error instanceof ApiError && error.status === 404) void reload()
      })
    } finally { inFlight.current = false }
  }
  if (draft === null) return <Row label={copy.renameDevice} onPress={() => setDraft(device.label ?? device.deviceName ?? '')} />
  return <View>
    <TextInput accessibilityLabel={copy.deviceLabel} value={draft} editable={status !== 'saving'}
      maxLength={80} onChangeText={value => { setDraft(value); setStatus('idle') }} returnKeyType="done" onSubmitEditing={() => void save()}
      style={{ minHeight: 48, paddingHorizontal: 16, fontFamily: font, fontSize: 16, color: colors.text, backgroundColor: colors.surface }} />
    <Row label={messages.Common.save} detail={status === 'failed' ? copy.renameFailed : undefined}
      disabled={!label || label.length > 80 || status === 'saving'} onPress={() => void save()} />
    <Row label={messages.Common.cancel} disabled={status === 'saving'} onPress={() => { setDraft(null); setStatus('idle') }} />
  </View>
}

function PushDevices() {
  const copy = messages.MobileCore.notifications
  const { data, error, loading, reload, reloadAfterWrite } = useApi<{ installations: PushInstallation[] }>('/api/mobile/push-tokens')
  const registration = usePushState()
  const previous = useRef(registration)
  const pending = useRef<number | null>(null)
  const [attempt, setAttempt] = useState<{ id: string; context: number; state: 'sending' | 'accepted' | 'failed' | 'limited' } | null>(null)
  const context = apiCache.context()
  const current = attempt?.context === context ? attempt : null
  async function testDevice(id: string) {
    if (apiCache.context() !== context || pending.current === context) return
    const connection = apiConnection()
    pending.current = context
    setAttempt({ id, context, state: 'sending' })
    try {
      const result = await api<{ accepted: boolean }>('/api/mobile/push-tokens/' + encodeURIComponent(id) + '/test',
        { method: 'POST', timeoutMs: 75_000 }, connection)
      apiCache.commit(context, () => setAttempt({ id, context, state: result?.accepted === true ? 'accepted' : 'failed' }))
    } catch (error) {
      apiCache.commit(context, () => {
        setAttempt({ id, context, state: error instanceof ApiError && error.status === 429 ? 'limited' : 'failed' })
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) void reloadAfterWrite()
      })
    } finally { if (pending.current === context) pending.current = null }
  }
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
      const status = current?.id === device.id ? current.state : null
      const feedback = status === 'accepted' ? copy.testAccepted : status === 'failed' ? copy.testFailed
        : status === 'limited' ? copy.testLimited : status === 'sending' ? copy.testSending : undefined
      return <View key={context + '-' + device.id}>
        <Row label={device.label || device.deviceName || platform} detail={device.label || device.deviceName ? `${platform} · ${date}` : date}
          value={device.currentSession ? messages.Settings.profile.currentSession : undefined} />
        {device.currentSession && device.canRename === true ? <DeviceLabel device={device} reload={reloadAfterWrite} /> : null}
        {device.currentSession && device.canTest === true ? <Row label={copy.testDevice} detail={feedback}
          disabled={current?.state === 'sending'} onPress={() => void testDevice(device.id)} /> : null}
      </View>
    })}
  </Group>
}

/**
 * 通知 (07c): 主动消息 and which of the Coordinator's own messages reach the
 * phone; above them, whether pushes can reach it at all (PushRow).
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
          <ToggleRow label={copy.pushReview} value={p.pushReview} disabled={preferenceSave.status !== 'idle'} onChange={pushReview => save({ pushReview })} />
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
