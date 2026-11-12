import { useRef, useState } from 'react'
import { ReadNotice } from '@/components/ReadNotice'
import { ActionSheetIOS, Linking, Platform, ScrollView, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUpRight, Bell, BookOpen, Blocks, BriefcaseBusiness, Globe, Hand, Info } from 'lucide-react-native'
import { CardButton } from '@/components/cards'
import { Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { PushRow } from '@/components/PushRow'
import { PreferenceSaveNotice } from '@/components/PreferenceSaveNotice'
import { Avatar, Row } from '@/components/settings'
import { Symbol, type SymbolName } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { authClient } from '@/lib/auth'
import { clearApiCache } from '@/lib/useApi'
import { usePluginConnections } from '@/features/plugins/use-plugin-connections'
import { useSettings } from '@/lib/settings'
import { versionLabel } from '@/lib/updates'
import { colors } from '@/lib/theme'
import { currentAccount, servers } from '@/lib/config'
import { serverCopy } from '@/lib/server-copy'
import { openPrivacyPolicy } from '@/lib/web'
import { mobileMessages as messages } from '@/lib/messages'

/** A row's icon (Comma design 18): a white glyph on a colored rounded square, as in the system Settings app. */
const icon = (name: SymbolName, Icon: typeof Bell, background: string) => (
  <View style={[tileStyle, { backgroundColor: background }]}>
    <Symbol name={name} size={16} color="#fff" web={<Icon size={17} color="#fff" strokeWidth={2} />} />
  </View>
)
const tileStyle = { width: 30, height: 30, borderRadius: 7, borderCurve: 'continuous' as const, alignItems: 'center' as const, justifyContent: 'center' as const }

/**
 * 设置 (Comma design 18), a hierarchy (R-70): the person, 工作区, then the Coordinator's settings and the app's, each
 * opening its own page, and 退出登录 last. Every row has a precedent (mobile.md, "Settings").
 */
export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { data, error, reload } = useSettings()
  const connections = usePluginConnections()
  const leaving = useRef(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutFailed, setSignOutFailed] = useState(false)
  const signOut = async () => {
    if (leaving.current) return
    leaving.current = true; setSigningOut(true); setSignOutFailed(false)
    const account = currentAccount(), client = authClient
    try {
      if (Platform.OS !== 'web') await (await import('@/lib/push')).unregisterPush().catch(() => undefined)
      const result = await client.signOut()
      if (result.error) throw new Error('signout_failed')
      if (currentAccount().id === account.id) clearApiCache()
      await servers.signedOut(account.id)
    } catch { setSignOutFailed(true) }
    finally { leaving.current = false; setSigningOut(false) }
  }
  // Signing out asks first, as the system's action sheet (usability review #6).
  const confirmSignOut = () => {
    if (Platform.OS !== 'ios') return void signOut()
    ActionSheetIOS.showActionSheetWithOptions({ options: ['退出登录', '取消'], destructiveButtonIndex: 0, cancelButtonIndex: 1 }, index => { if (index === 0) void signOut() })
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <NavBar title="设置" topTitle background={colors.grouped} />
      {!data && error ? (
        <View style={{ paddingTop: 40, alignItems: 'center', gap: 10 }}>
          <Text style={{ color: colors.danger, fontSize: 13 }}>设置加载失败。</Text>
          <CardButton label="重试" onPress={() => void reload()} />
        </View>
      ) : !data ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : (
        <ScrollView {...underBar} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}>
          <ReadNotice error={error} hasData label="设置" onRetry={reload} />
          <ReadNotice error={connections.error} hasData={connections.hasRetainedData} label={connections.noticeLabel} onRetry={connections.reload} />
          <PushRow proactive={data.preferences.proactive} />
          <PreferenceSaveNotice />
          <Group>
            <Row icon={<Avatar name={data.user.name || data.user.email} image={data.user.image} size={56} />} label={data.user.name || data.user.email} detail={data.user.email} onPress={() => router.push('/settings/profile')} />
            <Row label={serverCopy.accounts} value={currentAccount().server.name} onPress={() => router.push('/settings/accounts')} />
          </Group>
          <Group>
            <Row icon={icon('briefcase.fill', BriefcaseBusiness, '#8E8E93')} label="工作区" value={data.workspace.name} onPress={() => router.push('/settings/workspaces')} />
            {data.billingScope && <Row label={messages.Billing.management.billingEntry} onPress={() => router.push('/settings/billing')} />}
          </Group>
          <Group>
            <Row icon={icon('bell.fill', Bell, '#FF3B30')} label="通知" value={data.preferences.proactive ? '开' : '关'} onPress={() => router.push('/settings/notifications')} />
            <Row icon={icon('book.fill', BookOpen, '#AF52DE')} label="记忆" onPress={() => router.push('/settings/memory')} />
            <Row icon={icon('puzzlepiece.extension.fill', Blocks, '#34C759')} label="已连接的 App" value={connections.error ? '连接状态未知' : connections.snapshot ? String(connections.snapshot.toolkits.length) : undefined} onPress={() => router.push('/settings/plugins')} />
          </Group>
          <Group>
            <Row icon={icon('globe', Globe, '#5856D6')} label="语言" value="简体中文" trailing={Platform.OS === 'web' ? null : <Symbol name="arrow.up.right" size={13} color={colors.tertiary} web={<ArrowUpRight size={16} color={colors.tertiary} strokeWidth={2} />} />}
              onPress={Platform.OS === 'web' ? undefined : () => { void Linking.openSettings() }} />
            <Row icon={icon('info.circle.fill', Info, '#8E8E93')} label="版本" value={versionLabel()} trailing={null} />
            <Row icon={icon('hand.raised.fill', Hand, '#5856D6')} label={messages.Common.privacyPolicy} onPress={() => void openPrivacyPolicy()} />
          </Group>
          <Group>
            <Row label={signingOut ? "正在退出登录" : "退出登录"} disabled={signingOut} destructive onPress={confirmSignOut} />
          </Group>
          {signOutFailed ? <View accessibilityRole="alert" style={{ gap: 10 }}><Text style={{ color: colors.danger }}>退出登录未完成，请重试。</Text><CardButton label="重试退出登录" busy={signingOut} onPress={() => void signOut()} /></View> : null}
        </ScrollView>
      )}
    </View>
  )
}
