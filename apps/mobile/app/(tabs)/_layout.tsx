import { mobileMessages } from '@/lib/messages'
import { Platform } from 'react-native'
import { Tabs } from 'expo-router/js-tabs'
import { NativeTabs } from 'expo-router/native-tabs'
import { Bot, Lightbulb, ListChecks, Search, UserCircle } from 'lucide-react-native'
import { colors } from '@/lib/theme'

/**
 * The app's places, as the system's tab bar with Liquid Glass: Bot, 任务, 建议 and 设置, then the system search tab
 * (decisions/2026-11-07-2045-tasks-only-threads-inside.md; no 线程 tab, threads open inside their task). A chat, a
 * task and a thread open over the tabs, so the tab bar goes away there. The tabs carry no badges (Alex 2026-11-06).
 */
export default function TabsLayout() {
  if (Platform.OS === 'web') return <WebTabs />
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="(chats)">
        {/* SF Symbols has no robot: lucide's bot as a template image, so the system tints it like the others. */}
        <NativeTabs.Trigger.Icon src={{ default: require('@/assets/tabs/bot.png'), selected: require('@/assets/tabs/bot-fill.png') }} renderingMode="template" />
        <NativeTabs.Trigger.Label>Bot</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon sf="checklist" />
        <NativeTabs.Trigger.Label>{mobileMessages.Nav.tasks}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="suggestions">
        <NativeTabs.Trigger.Icon sf={{ default: 'lightbulb', selected: 'lightbulb.fill' }} />
        <NativeTabs.Trigger.Label>{mobileMessages.Nav.suggestions}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <NativeTabs.Trigger.Label>{mobileMessages.Nav.settings}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>{mobileMessages.Common.search}</NativeTabs.Trigger.Label>
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
      <Tabs.Screen name="(chats)" options={{ title: 'Bot', tabBarIcon: icon(Bot) }} />
      <Tabs.Screen name="tasks" options={{ title: mobileMessages.Nav.tasks, tabBarIcon: icon(ListChecks) }} />
      <Tabs.Screen name="suggestions" options={{ title: mobileMessages.Nav.suggestions, tabBarIcon: icon(Lightbulb) }} />
      <Tabs.Screen name="settings" options={{ title: mobileMessages.Nav.settings, tabBarIcon: icon(UserCircle) }} />
      <Tabs.Screen name="search" options={{ title: mobileMessages.Common.search, tabBarIcon: icon(Search) }} />
    </Tabs>
  )
}
