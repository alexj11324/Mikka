import { Text } from '@/components/Text'
import { optionName, type ModelMenuState } from '@/lib/model-menu'
import { colors } from '@/lib/theme'

/** The web build's model chip, for screenshot checks: it names the model (iOS has the native menu, ModelMenu.ios.tsx). */
export function ModelMenu({ model }: { model: ModelMenuState }) {
  const { menu } = model
  if (!menu) return null
  const name = optionName(menu.current)
  return <Text style={{ fontSize: 13, color: menu.current.available ? colors.ink : colors.secondary }}>{menu.current.available ? name : `${name} · 不可用`}</Text>
}
