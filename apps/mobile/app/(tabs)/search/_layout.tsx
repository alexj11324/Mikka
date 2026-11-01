import { Stack } from 'expo-router'
import { colors, screenOptions } from '@/lib/theme'

export default function TabStack() {
  return <Stack screenOptions={screenOptions(colors.page)} />
}
