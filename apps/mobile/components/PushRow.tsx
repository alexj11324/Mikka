import { Linking } from 'react-native'
import { BellOff, BellRing } from 'lucide-react-native'
import { Row } from '@/components/settings'
import { Group } from '@/components/ui'
import { askForPush, pushUndeliverable, retryPush, usePushState } from '@/lib/push-state'
import { colors } from '@/lib/theme'

/**
 * Whether the Coordinator's pushes can reach this phone, shown only when they
 * cannot (mobile.md Settings, "Push not deliverable"; Comma iOS): iOS said no
 * → its Settings; registering failed → try again. `ask` also offers iOS's
 * prompt when it has not been shown (on 通知).
 */
export function PushRow({ proactive, ask = false }: { proactive: boolean; ask?: boolean }) {
  const push = usePushState()
  if (!proactive) return null
  if (pushUndeliverable(push)) {
    const denied = push === 'denied'
    return (
      <Group>
        <Row icon={<BellOff size={21} color={colors.danger} strokeWidth={1.8} />} label="推送无法送达" value={denied ? '打开设置' : '重试'}
          onPress={() => void (denied ? Linking.openSettings() : retryPush())} />
      </Group>
    )
  }
  if (ask && push === 'undetermined') {
    return (
      <Group>
        <Row icon={<BellRing size={21} color={colors.ink} strokeWidth={1.8} />} label="允许推送" onPress={() => void askForPush()} />
      </Group>
    )
  }
  return null
}
