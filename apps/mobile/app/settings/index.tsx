import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUpRight, Bell, BookOpen, Blocks, BriefcaseBusiness, Globe, Info, LogOut } from 'lucide-react-native'
import { CardButton } from '@/components/cards'
import { Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { PushRow } from '@/components/PushRow'
import { Avatar, Row } from '@/components/settings'
import { Symbol, type SymbolName } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { CloseButton, Group } from '@/components/ui'
import { authClient } from '@/lib/auth'
import { useSettings } from '@/lib/settings'
import { versionLabel } from '@/lib/updates'
import { colors } from '@/lib/theme'

const icon = (name: SymbolName, Icon: typeof Bell, color: string = colors.ink) => <Symbol name={name} size={19} color={color} web={<Icon size={21} color={color} strokeWidth={1.8} />} />

/**
 * Settings, a hierarchy (R-70): categories here, each opens its own page.
 * Every row has a precedent (mobile.md, "Settings").
 */
export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { data, error, reload } = useSettings()
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'))
  const signOut = async () => {
    if (Platform.OS !== 'web') await (await import('@/lib/push')).unregisterPush()
    await authClient.signOut()
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      {Platform.OS === 'ios' ? <NavBar title="设置" right={{ icon: 'xmark', label: '关闭', onPress: close, web: null }} /> : (
        <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
          <Text style={styles.title}>设置</Text>
          <CloseButton onPress={close} />
        </View>
      )}
      {!data && error ? (
        <View style={{ paddingTop: 40, alignItems: 'center', gap: 10 }}>
          <Text style={{ color: colors.danger, fontSize: 13 }}>设置加载失败。</Text>
          <CardButton label="重试" onPress={() => void reload()} />
        </View>
      ) : !data ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : (
        <ScrollView {...underBar} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}>
          <PushRow proactive={data.preferences.proactive} />
          <Group>
            <Row icon={<Avatar name={data.user.name || data.user.email} image={data.user.image} size={40} />} label={data.user.name || data.user.email} detail={data.user.email} onPress={() => router.push('/settings/profile')} />
            <Row icon={icon('briefcase', BriefcaseBusiness)} label="工作区" value={data.workspace.name} onPress={() => router.push('/settings/workspace')} />
          </Group>
          <Group label="Coordinator">
            <Row icon={icon('bell', Bell)} label="通知" value={data.preferences.proactive ? '开' : '关'} onPress={() => router.push('/settings/notifications')} />
            <Row icon={icon('book', BookOpen)} label="记忆" onPress={() => router.push('/settings/memory')} />
            <Row icon={icon('square.grid.2x2', Blocks)} label="已连接的 App" onPress={() => router.push('/settings/apps')} />
          </Group>
          <Group label="App">
            <Row icon={icon('globe', Globe)} label="语言" value="简体中文" trailing={<Symbol name="arrow.up.right" size={13} color={colors.tertiary} web={<ArrowUpRight size={16} color={colors.tertiary} strokeWidth={2} />} />}
              onPress={() => { if (Platform.OS !== 'web') void Linking.openSettings() }} />
            <Row icon={icon('info.circle', Info)} label="版本" value={versionLabel()} trailing={null} />
          </Group>
          <Group>
            <Row icon={icon('rectangle.portrait.and.arrow.right', LogOut, colors.danger)} label="退出登录" destructive onPress={() => void signOut()} />
          </Group>
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 32, fontWeight: '700' },
})
