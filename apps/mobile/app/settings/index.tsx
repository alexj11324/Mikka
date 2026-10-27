import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUpRight, Bell, BookOpen, Blocks, BriefcaseBusiness, Globe, Info, LogOut, Sun } from 'lucide-react-native'
import { Row } from '@/components/settings'
import { Text } from '@/components/Text'
import { CloseButton, Group } from '@/components/ui'
import { me } from '@/lib/mock'
import { colors } from '@/lib/theme'

const icon = (Icon: typeof Bell, color: string = colors.ink) => <Icon size={21} color={color} strokeWidth={1.8} />

/**
 * Settings, a hierarchy (R-70): categories here, each opens its own page.
 * Every row has a precedent (mobile.md, "Settings").
 */
export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'))
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.title}>设置</Text>
        <CloseButton onPress={close} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}>
        <Group>
          <Row
            icon={<View style={styles.avatar}><Text style={styles.avatarText}>{me.initials}</Text></View>}
            label={me.name}
            detail={me.email}
            onPress={() => router.push('/settings/profile')}
          />
          <Row icon={icon(BriefcaseBusiness)} label="工作区" value={me.workspace} onPress={() => router.push('/settings/workspace')} />
        </Group>
        <Group label="Coordinator">
          <Row icon={icon(Bell)} label="通知" value="开" onPress={() => router.push('/settings/notifications')} />
          <Row icon={icon(BookOpen)} label="记忆" onPress={() => router.push('/settings/memory')} />
          <Row icon={icon(Blocks)} label="已连接的 App" onPress={() => router.push('/settings/apps')} />
        </Group>
        <Group label="App">
          <Row icon={icon(Sun)} label="外观" value="跟随系统" onPress={() => {}} />
          <Row icon={icon(Globe)} label="语言" value="简体中文" trailing={<ArrowUpRight size={16} color={colors.tertiary} strokeWidth={2} />}
            onPress={() => { if (Platform.OS !== 'web') void Linking.openSettings() }} />
          <Row icon={icon(Info)} label="版本" value="1.0 (1)" trailing={null} />
        </Group>
        <Group>
          <Row icon={icon(LogOut, colors.danger)} label="退出登录" destructive onPress={close} />
        </Group>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 32, fontWeight: '700' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#55705F', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '600' },
})
