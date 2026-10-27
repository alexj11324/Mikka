import { Pressable, StyleSheet, View } from 'react-native'
import { Row, SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { me } from '@/lib/mock'
import { colors } from '@/lib/theme'

/** 个人资料: photo and name; email read-only (Comma iOS Profile, Claude). */
export default function ProfileScreen() {
  return (
    <SettingsPage title="个人资料">
      <View style={styles.hero}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{me.initials}</Text></View>
        <Pressable accessibilityRole="button"><Text style={styles.edit}>编辑</Text></Pressable>
      </View>
      <Group>
        <Row label="名字" value={me.name} trailing={null} />
        <Row label="邮箱" value={me.email} trailing={null} />
      </Group>
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 10, marginBottom: 20 },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: '#55705F', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 30, fontWeight: '600' },
  edit: { color: colors.accent, fontSize: 15 },
})
