import { Platform } from 'react-native'
import { Tabs } from 'expo-router/js-tabs'
import { NativeTabs } from 'expo-router/native-tabs'
import { Lightbulb, Layers, MessagesSquare, Search, UserCircle } from 'lucide-react-native'
import { colors } from '@/lib/theme'

/**
 * The app's places, as the system's tab bar with Liquid Glass (docs/design/mobile-comma-redesign.md, Alex
 * 2026-11-06): 对话, 线程 (with 任务), 建议 and 设置, then the system search tab. A chat or a thread opens over the
 * tabs, so the tab bar goes away there. The tabs carry no badges (Alex 2026-11-06).
 */
export default function TabsLayout() {
  if (Platform.OS === 'web') return <WebTabs />
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="(chats)">
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} />
        <NativeTabs.Trigger.Label>对话</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="threads">
        <NativeTabs.Trigger.Icon sf={{ default: 'rectangle.stack', selected: 'rectangle.stack.fill' }} />
        <NativeTabs.Trigger.Label>线程</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="suggestions">
        <NativeTabs.Trigger.Icon sf={{ default: 'lightbulb', selected: 'lightbulb.fill' }} />
        <NativeTabs.Trigger.Label>建议</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <NativeTabs.Trigger.Label>设置</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>搜索</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}

/** The web build, used for screenshot checks: the same five tabs as a bar at the foot (NativeTabs draws a top bar there). */
function WebTabs() {
  const icon = (Icon: typeof Search) => ({ color }: { color: unknown }) => <Icon size={22} color={String(color)} strokeWidth={2} />
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.accent, tabBarInactiveTintColor: colors.secondary,
      tabBarStyle: { backgroundColor: colors.page, borderTopColor: colors.separator } }}>
      <Tabs.Screen name="(chats)" options={{ title: '对话', tabBarIcon: icon(MessagesSquare) }} />
      <Tabs.Screen name="threads" options={{ title: '线程', tabBarIcon: icon(Layers) }} />
      <Tabs.Screen name="suggestions" options={{ title: '建议', tabBarIcon: icon(Lightbulb) }} />
      <Tabs.Screen name="settings" options={{ title: '设置', tabBarIcon: icon(UserCircle) }} />
      <Tabs.Screen name="search" options={{ title: '搜索', tabBarIcon: icon(Search) }} />
    </Tabs>
  )
}
