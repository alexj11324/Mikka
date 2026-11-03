import { Text } from '@/components/Text'
import { modelMenuLabel, modelMenuReadLabel, type ModelMenuState } from '@/lib/model-menu'
import { colors } from '@/lib/theme'

/** The web build's model chip, for screenshot checks: it names the model (iOS has the native menu, ModelMenu.ios.tsx). */
export function ModelMenu({ model, running = false }: { model: ModelMenuState; running?: boolean }) {
  const { menu, loading, retryRead } = model
  if (!menu) return <Pressable accessibilityRole="button" accessibilityState={{ disabled: loading, busy: loading }} disabled={loading} onPress={() => { void retryRead().catch(() => undefined) }}><Text style={{ fontSize: 13, color: colors.secondary }}>{modelMenuReadLabel(loading)}</Text></Pressable>
  const unavailable = !menu.current.available && menu.current.availability !== 'checking'
  return <Text style={{ fontSize: 13, color: unavailable ? colors.secondary : colors.ink }}>{modelMenuLabel(menu.current, running)}</Text>
}
import { Pressable } from 'react-native'
