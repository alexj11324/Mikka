import { Button, HStack, Host, Image, Menu, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { buttonStyle, controlSize, disabled, tint } from '@expo/ui/swift-ui/modifiers'
import { groupTag, groupTitle, modelMenuLabel, modelMenuReadLabel, optionName, type ModelMenuControls } from '@/lib/model-menu'
import { colors } from '@/lib/theme'
import { mobileMessages as copy } from '@/lib/messages'

/**
 * The model chip beside the composer's 「+」: a borderless SwiftUI menu like 「+」's
 * (AttachMenu.ios.tsx). Each group is a section; the current model is ticked;
 * who pays shows under the name; 刷新 re-reads the list. Saved per bot for its next runs;
 * a pick that does not save keeps the saved model here (ModelNotice says why).
 */
export function ModelMenu({ model, running = false, label: override }: { model: ModelMenuControls; running?: boolean; label?: string }) {
  const { menu, choose, refresh, refreshing, refreshFailed, loading, retryRead, busy } = model
  if (!menu) return <Host matchContents>{loading
    ? <Text>{modelMenuReadLabel(true)}</Text>
    : <Button label={modelMenuReadLabel(false)} systemImage="arrow.clockwise" onPress={() => { void retryRead().catch(() => undefined) }} modifiers={[buttonStyle('borderless'), controlSize('small'), tint(colors.secondary)]} />}</Host>
  const { current, groups } = menu
  const label = override ?? modelMenuLabel(current, running)
  const unavailable = !current.available && current.availability !== 'checking'
  return (
    <Host matchContents>
      {/* The name first, the chevron after it (「GPT-6 Luna ⌄」, #1386); systemImage would put it before. */}
      <Menu label={<HStack spacing={3}><Text>{label}</Text><Image systemName="chevron.down" size={10} /></HStack>} modifiers={[buttonStyle('borderless'), controlSize('small'), disabled(busy), tint(override ? colors.accent : unavailable ? colors.secondary : colors.ink)]}>
        {groups.map((group, index) => (
          <Section key={`${group.kind}-${index}`} title={groupTitle(group)}>
            {group.options.map(option => {
              const tag = groupTag(group)
              return (
                <Toggle key={option.id} isOn={current.id === option.id} onIsOnChange={() => { void choose(option.id) }}>
                  {tag ? [<Text key="name">{optionName(option)}</Text>, <Text key="tag">{tag}</Text>] : <Text>{optionName(option)}</Text>}
                </Toggle>
              )
            })}
          </Section>
        ))}
        <Section>
          <Button label={refreshing ? copy.Common.loading : refreshFailed ? copy.Coordinator.modelPicker.refreshFailed : copy.Coordinator.modelPicker.refresh} systemImage="arrow.clockwise" onPress={() => { void refresh() }} />
        </Section>
      </Menu>
    </Host>
  )
}
