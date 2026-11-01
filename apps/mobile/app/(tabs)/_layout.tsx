import { NativeTabs } from 'expo-router/native-tabs'
import { useHome } from '@/lib/home'

/**
 * The app's two places, as the system's tab bar (Liquid Glass on iOS 26):
 * 对话, the bots and group chats; 线程, every thread by state. A chat or a
 * thread opens over the tabs (decision 2026-10-31-2330).
 */
export default function TabsLayout() {
  const waiting = useHome().data?.threads.waiting ?? 0
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} />
        <NativeTabs.Trigger.Label>对话</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="threads">
        <NativeTabs.Trigger.Icon sf={{ default: 'checklist', selected: 'checklist' }} />
        <NativeTabs.Trigger.Label>线程</NativeTabs.Trigger.Label>
        {waiting ? <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
