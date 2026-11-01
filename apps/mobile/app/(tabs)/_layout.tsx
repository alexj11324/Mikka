import { NativeTabs } from 'expo-router/native-tabs'
import { DrawerHost } from '@/components/Drawer'
import { useHome } from '@/lib/home'

/**
 * The app's places, as the system's tab bar (Liquid Glass on iOS 26): 对话,
 * the bots and group chats; 线程, every thread by state; and 搜索, the
 * system's search tab, its field at the bottom (Alex's Grok screenshot). A
 * chat or a thread opens over the tabs (decision 2026-10-31-2330). The drawer
 * (the avatar on 对话, or a swipe right on a tab) slides the tabs aside.
 */
export default function TabsLayout() {
  const waiting = useHome().data?.threads.waiting ?? 0
  return (
    <DrawerHost>
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
        <NativeTabs.Trigger name="search" role="search">
          <NativeTabs.Trigger.Label>搜索</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </DrawerHost>
  )
}
