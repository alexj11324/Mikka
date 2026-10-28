import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { Avatar, Row, SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { authClient } from '@/lib/auth'
import { useSettings } from '@/lib/settings'
import { colors, font } from '@/lib/theme'

/** 个人资料: photo and name; email read-only (Comma iOS Profile, Claude). The name saves when the field is left. */
export default function ProfileScreen() {
  const { data, setData } = useSettings()
  const [name, setName] = useState(data?.user.name ?? '')
  if (!data) return <SettingsPage title="个人资料"><View /></SettingsPage>
  const save = async () => {
    const next = name.trim()
    if (!next || next === data.user.name) return setName(data.user.name)
    const result = await authClient.updateUser({ name: next })
    if (result.error) return setName(data.user.name)
    setData(current => current && { ...current, user: { ...current.user, name: next } })
  }
  return (
    <SettingsPage title="个人资料">
      <View style={styles.hero}><Avatar name={data.user.name || data.user.email} image={data.user.image} size={88} /></View>
      <Group>
        <View style={styles.row}>
          <Text style={styles.label}>名字</Text>
          <TextInput value={name} onChangeText={setName} onBlur={() => void save()} onSubmitEditing={() => void save()} returnKeyType="done" style={styles.input} />
        </View>
        <Row label="邮箱" value={data.user.email} trailing={null} />
      </Group>
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: 20 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, gap: 12, backgroundColor: '#fff' },
  label: { fontSize: 16 },
  input: { flex: 1, minWidth: 0, textAlign: 'right', fontSize: 15, color: colors.secondary, fontFamily: font, outlineStyle: 'none' } as never,
})
