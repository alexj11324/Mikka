import { Pressable } from 'react-native'
import { MachineIcon } from '@/components/icons'
import { api } from '@/lib/api'
import { machineLines, type ThreadMachine, type ThreadMachineKind } from '@/lib/thread-machine'
import { showSystemAlert } from '@/lib/system-alert'

/** The machine icon in a thread's title on the web build and Android: a tap names the machine in an alert (the iOS build shows a popover). */
export function ThreadPlace({ threadId, kind }: { threadId: string; kind: ThreadMachineKind }) {
  const show = async () => {
    try {
      const { machine } = await api<{ machine: ThreadMachine | null }>(`/api/mobile/threads/${threadId}/machine`)
      if (!machine) return
      const lines = machineLines(machine)
      showSystemAlert(`${lines.name} · ${lines.state}`, lines.rows.map(([label, value]) => `${label}  ${value}`).join('\n'))
    } catch { showSystemAlert('读取失败') }
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="运行在哪台机器" hitSlop={12} onPress={() => { void show() }}>
      <MachineIcon machine={kind} size={11} />
    </Pressable>
  )
}
