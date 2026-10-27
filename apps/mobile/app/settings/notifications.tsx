import { useState } from 'react'
import { ChoiceRow, SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'

/** 通知 (07c): 主动消息, per-event pushes, and when to push to the phone (Slack "Notify me on mobile"). */
export default function NotificationsScreen() {
  const [proactive, setProactive] = useState(true)
  const [events, setEvents] = useState({ decide: true, review: true, finished: false, briefing: true })
  const [when, setWhen] = useState<'always' | 'away'>('always')
  const toggle = (key: keyof typeof events) => (next: boolean) => setEvents(e => ({ ...e, [key]: next }))
  return (
    <SettingsPage title="通知">
      <Group><ToggleRow label="主动消息" value={proactive} onChange={setProactive} /></Group>
      <Group label="推送这些事">
        <ToggleRow label="需要你决策" value={events.decide} onChange={toggle('decide')} />
        <ToggleRow label="待审阅" value={events.review} onChange={toggle('review')} />
        <ToggleRow label="线程完成" value={events.finished} onChange={toggle('finished')} />
        <ToggleRow label="每日简报" value={events.briefing} onChange={toggle('briefing')} />
      </Group>
      <Group label="推送到手机">
        <ChoiceRow label="立即，即使电脑在用" selected={when === 'always'} onPress={() => setWhen('always')} />
        <ChoiceRow label="电脑不在用时" selected={when === 'away'} onPress={() => setWhen('away')} />
      </Group>
    </SettingsPage>
  )
}
