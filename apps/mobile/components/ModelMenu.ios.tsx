import { Host, Menu, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { buttonStyle, controlSize, tint } from '@expo/ui/swift-ui/modifiers'
import { groupTag, groupTitle, optionName, useModelMenu } from '@/lib/model-menu'
import { colors } from '@/lib/theme'

/**
 * The model chip beside the composer's 「+」: a SwiftUI menu like 「+」's
 * (AttachMenu.ios.tsx). Each group is a section; the current model is ticked;
 * who pays shows under the name. Saved per bot for its next runs.
 */
export function ModelMenu({ botId }: { botId: string | null }) {
  const { menu, choose, failed } = useModelMenu(botId)
  if (!menu) return null
  const { current, groups } = menu
  const name = optionName(current)
  const label = !current.available ? `${name} · 不可用` : failed ? `${name} · 未保存` : name
  return (
    <Host matchContents>
      <Menu label={label} systemImage="chevron.down" modifiers={[buttonStyle('glass'), controlSize('small'), tint(current.available ? colors.ink : colors.secondary)]}>
        {groups.map((group, index) => (
          <Section key={`${group.kind}-${index}`} title={groupTitle(group)}>
            {group.options.map(option => {
              const tag = groupTag(group)
              return (
                <Toggle key={option.id} isOn={current.available && current.id === option.id} onIsOnChange={() => { void choose(option.id) }}>
                  {tag ? [<Text key="name">{optionName(option)}</Text>, <Text key="tag">{tag}</Text>] : <Text>{optionName(option)}</Text>}
                </Toggle>
              )
            })}
          </Section>
        ))}
      </Menu>
    </Host>
  )
}
