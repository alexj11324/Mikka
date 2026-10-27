import { Stack } from 'expo-router'
import { SettingsProvider } from '@/lib/settings'
import { colors } from '@/lib/theme'

export default function SettingsLayout() {
  return (
    <SettingsProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.grouped } }} />
    </SettingsProvider>
  )
}
