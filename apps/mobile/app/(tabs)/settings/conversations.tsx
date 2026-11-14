import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import { ChoiceRow, SettingsPage } from '@/components/settings'
import { Group } from '@/components/ui'
import { Text } from '@/components/Text'
import { PreferenceSaveNotice } from '@/components/PreferenceSaveNotice'
import { mobileLocale, mobileMessages } from '@/lib/messages'
import { useSettings } from '@/lib/settings'
import { archiveIdleDays } from '../../../../../lib/conversation-directory-input'

const labels = mobileMessages.ConversationDirectory
const formatDays = new Intl.NumberFormat(mobileLocale, { style: 'unit', unit: 'day', unitDisplay: 'long' })

export default function ConversationPreferences() {
  const { data, reload, savePreferences, preferenceSave } = useSettings()
  useFocusEffect(useCallback(() => { void reload() }, [reload]))
  const current = data?.preferences.archiveIdleAfterDays
  return <SettingsPage title={labels.archiveIdle}>
    {current === undefined ? <Text>{labels.archiveUnavailable}</Text> : <Group>
      {archiveIdleDays.map(days => <ChoiceRow key={days} label={days === 0 ? labels.archiveOff : formatDays.format(days)}
        selected={current === days} disabled={preferenceSave.status !== 'idle'}
        busy={preferenceSave.status === 'saving' && preferenceSave.intent.archiveIdleAfterDays === days}
        onPress={() => { if (current !== days) void savePreferences({ archiveIdleAfterDays: days }) }} />)}
    </Group>}
    <PreferenceSaveNotice />
  </SettingsPage>
}
