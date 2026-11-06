import { Stack } from 'expo-router'
import { colors, screenOptions } from '@/lib/theme'

/** A tab's own stack: its root page with a large title, and what it pushes. */
export default function TabStack() {
  return <Stack screenOptions={screenOptions(colors.grouped)} />
}
