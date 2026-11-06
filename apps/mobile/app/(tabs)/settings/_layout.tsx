import { Stack } from 'expo-router'
import { SettingsProvider } from '@/lib/settings'
import { colors, screenOptions } from '@/lib/theme'

export default function SettingsLayout() {
  return (
    <SettingsProvider>
      <Stack screenOptions={screenOptions(colors.grouped)} />
    </SettingsProvider>
  )
}
