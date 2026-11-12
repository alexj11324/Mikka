import { useEffect, useRef, useState } from 'react'
import { CardButton } from '@/components/cards'
import { StyleSheet, TextInput, View } from 'react-native'
import { Avatar, Row, SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { api, apiConnection } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { saveProfileName } from '@/lib/profile-name'
import { useSettings } from '@/lib/settings'
import { colors, font } from '@/lib/theme'
import { openAccountDeletion } from '@/lib/web'
import { mobileMessages as messages } from '@/lib/messages'

/** 个人资料: photo and name; email read-only (Comma iOS Profile, Claude). The name saves when the field is left. */
export default function ProfileScreen() {
  const { data, setData } = useSettings()
  const [name, setName] = useState(data?.user.name ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const saving = useRef(false), dirty = useRef(false)
  useEffect(() => { if (!dirty.current && !saving.current) setName(data?.user.name ?? '') }, [data?.user.name])
  if (!data) return <SettingsPage title="个人资料"><View /></SettingsPage>
  const save = async () => {
    if (saving.current) return
    const next = name.trim()
    if (!next) { setProblem('请输入名字'); return }
    if (next === data.user.name) { dirty.current = false; setName(next); setProblem(null); return }
    saving.current = true; setBusy(true); setProblem(null)
    try {
      const connection = apiConnection()
      const context = apiCache.context()
      const saved = await saveProfileName(next, (path, init) => api(path, init, connection))
      apiCache.commit(context, () => {
        setData(current => current && { ...current, user: { ...current.user, name: saved } })
        dirty.current = false; setName(saved)
        connection.client.$store.notify('$sessionSignal')
      })
    } catch { setProblem('名字未保存，修改已保留。') }
    finally { saving.current = false; setBusy(false) }
  }
  return (
    <SettingsPage title="个人资料">
      <View style={styles.hero}><Avatar name={data.user.name || data.user.email} image={data.user.image} size={88} /></View>
      <Group>
        <View style={styles.row}>
          <Text style={styles.label}>名字</Text>
          <TextInput accessibilityLabel="名字" accessibilityState={{ busy, disabled: busy }} editable={!busy} value={name} onChangeText={value => { dirty.current = true; setName(value); setProblem(null) }} onBlur={() => void save()} onSubmitEditing={() => void save()} returnKeyType="done" style={styles.input} />
        </View>
        <Row label="邮箱" value={data.user.email} trailing={null} />
      </Group>
      {busy ? <Text accessibilityLiveRegion="polite">正在保存名字</Text> : null}
      {problem ? <View accessibilityRole="alert" style={{ gap: 10 }}><Text style={{ color: colors.danger }}>{problem}</Text><CardButton label="重试保存" onPress={() => void save()} /></View> : null}
      <Group>
        <Row label={messages.Settings.profile.deleteAccount} destructive onPress={() => void openAccountDeletion()} />
      </Group>
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: 20 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, gap: 12, backgroundColor: colors.surface },
  label: { fontSize: 16 },
  input: { flex: 1, minWidth: 0, textAlign: 'right', fontSize: 15, color: colors.secondary, fontFamily: font, outlineStyle: 'none' } as never,
})
