import { View } from 'react-native'
import { CardButton } from '@/components/cards'
import { Text } from '@/components/Text'
import { mobileMessages as messages } from '@/lib/messages'
import { useSettings } from '@/lib/settings'
import { colors } from '@/lib/theme'

const names: Record<string, string> = { ...messages.Settings.notifications, memoryEnabled: messages.Settings.memory.enabled }

/** Pending intention is separate from the switches' last confirmed values. */
export function PreferenceSaveNotice() {
  const { preferenceSave, retryPreferences } = useSettings()
  if (preferenceSave.status === 'idle') return null
  const copy = messages.MobileCore.notifications
  const saving = preferenceSave.status === 'saving'
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ gap: 8, marginTop: 12, marginBottom: 16 }}>
    {Object.entries(preferenceSave.intent).map(([key, value]) => <Text key={key} style={{ fontSize: 13, color: saving ? colors.secondary : colors.danger }}>
      {key === 'archiveIdleAfterDays'
        ? (saving ? messages.Common.saving : messages.ConversationDirectory.archiveSaveError)
        : `${names[key] ?? key} · ${saving ? value ? copy.savingOn : copy.savingOff : value ? copy.unconfirmedOn : copy.unconfirmedOff}`}
    </Text>)}
    {!saving ? <CardButton label={copy.retrySave} onPress={() => void retryPreferences()} /> : null}
  </View>
}
