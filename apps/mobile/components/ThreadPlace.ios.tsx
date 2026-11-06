import { useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Button, HStack, Host, Image, Popover, Text, VStack } from '@expo/ui/swift-ui'
import { buttonStyle, controlSize, font, foregroundStyle, padding, tint } from '@expo/ui/swift-ui/modifiers'
import { api } from '@/lib/api'
import { colors } from '@/lib/theme'
import { MACHINE_SYMBOL, machineLines, type ThreadMachine, type ThreadMachineKind } from '@/lib/thread-machine'

/**
 * The machine icon in a thread's title (Alex, 2026-11-06: icons only, the name on tap). A tap reads which
 * machine it is and shows it in a popover: name, state, and for a cloud machine its full ID to copy.
 */
export function ThreadPlace({ threadId, kind }: { threadId: string; kind: ThreadMachineKind }) {
  const [open, setOpen] = useState(false)
  const [machine, setMachine] = useState<ThreadMachine | null | undefined>(undefined)
  const show = async () => {
    setOpen(true)
    try { setMachine((await api<{ machine: ThreadMachine | null }>(`/api/mobile/threads/${threadId}/machine`)).machine) }
    catch { setMachine(null) }
  }
  const lines = machine ? machineLines(machine) : null
  return (
    <Host matchContents>
      <Popover isPresented={open} onIsPresentedChange={setOpen} arrowEdge="top">
        <Popover.Trigger>
          <Button onPress={() => { void show() }} modifiers={[buttonStyle('borderless'), controlSize('mini'), tint(colors.secondary)]}>
            <Image systemName={MACHINE_SYMBOL[kind]} size={11} />
          </Button>
        </Popover.Trigger>
        <Popover.Content>
          <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 16 })]}>
            {lines ? <>
              <HStack spacing={8}>
                <Image systemName={MACHINE_SYMBOL[machine!.kind]} size={17} />
                <Text modifiers={[font({ textStyle: 'headline' })]}>{lines.name}</Text>
                <Text modifiers={[font({ textStyle: 'subheadline', weight: 'medium' }), foregroundStyle(lines.live ? colors.success : lines.failed ? colors.danger : { type: 'hierarchical', style: 'secondary' })]}>{`● ${lines.state}`}</Text>
              </HStack>
              {lines.rows.map(([label, value]) => (
                <HStack key={label} spacing={10}>
                  <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{label}</Text>
                  <Text modifiers={[font({ textStyle: 'subheadline', design: label === 'ID' || label === '模板' ? 'monospaced' : 'default' })]}>{value}</Text>
                </HStack>
              ))}
              {machine?.cloud ? <Button label="复制 ID" systemImage="doc.on.doc" onPress={() => { void Clipboard.setStringAsync(machine.cloud!.sandboxId) }} /> : null}
            </> : <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{machine === null ? '读取失败' : '读取中'}</Text>}
          </VStack>
        </Popover.Content>
      </Popover>
    </Host>
  )
}
