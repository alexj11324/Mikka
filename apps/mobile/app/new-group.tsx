import { useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Check, X } from 'lucide-react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { Field, Group } from '@/components/ui'
import { api } from '@/lib/api'
import { tap } from '@/lib/haptics'
import { useHome } from '@/lib/home'
import { openChat } from '@/lib/navigate'
import { colors, font } from '@/lib/theme'

/**
 * 新建群聊 (Comma design 07), a form sheet from 对话's 新建: a name and the bots in it, ticked. In the group each
 * message goes to the bot it @mentions, else to the ones Mikka judges should
 * answer (lib/coordinator/group-judgment.ts).
 */
export default function NewGroup() {
  const router = useRouter()
  const home = useHome()
  // A group is made of the person's own bots, as before the Coordinator had a bot row.
  const bots = (home.data?.bots ?? []).filter(bot => !bot.coordinator)
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const ready = Boolean(title.trim() && picked.length && home.data)
  const create = async () => {
    if (!ready || busy || !home.data) return
    setBusy(true)
    setFailed(false)
    try {
      const group = await api<{ id: string }>('/api/conversations', { method: 'POST', body: {
        workspaceId: home.data.workspace.id, title: title.trim(), members: picked.map(id => ({ memberType: 'bot', memberId: id })),
      } })
      tap()
      openChat(`/groups/${group.id}`)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const toggle = (id: string) => { tap(); setPicked(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]) }
  return (
    <View style={styles.screen}>
      <NavBar title="新建群聊"
        left={{ icon: 'xmark', label: '取消', disabled: busy, web: <X size={20} color={colors.ink} />, onPress: () => router.back() }}
        right={{ icon: 'checkmark', label: busy ? '创建中' : '创建', disabled: !ready || busy, busy, prominent: true, web: <Check size={20} color={colors.accent} strokeWidth={2.4} />, onPress: () => void create() }} />
      <ScrollView {...underBar} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Field style={styles.field}>
          <TextInput editable={!busy} value={title} onChangeText={setTitle} placeholder="群聊名称" placeholderTextColor={colors.secondary} maxLength={200} autoFocus
            style={styles.input} accessibilityLabel="群聊名称" />
        </Field>
        {failed ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.problem}>没能创建</Text> : null}
        <ReadNotice error={home.error} hasData={Boolean(home.data)} label="Bot 列表" onRetry={home.reload} />
        {home.loading && !home.data ? <View style={{ alignItems: 'center', paddingVertical: 16 }}><Spinner /></View> : null}
        <Group label="Bot" backgroundColor={colors.bubble}>
          {bots.map(bot => {
            const on = picked.includes(bot.id)
            return (
              <Pressable key={bot.id} accessibilityRole="checkbox" accessibilityLabel={bot.name} accessibilityState={{ checked: on, disabled: busy }} aria-checked={Platform.OS === 'web' ? on : undefined} aria-disabled={Platform.OS === 'web' ? busy : undefined} disabled={busy} onPress={() => toggle(bot.id)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
                <BotAvatar color={bot.color} shape={bot.shape} size={30} />
                <Text style={styles.name} numberOfLines={1}>{bot.name}</Text>
                {on ? <Symbol name="checkmark" size={19} color={colors.accent} web={<Check size={22} color={colors.accent} strokeWidth={2.2} />} /> : null}
              </Pressable>
            )
          })}
        </Group>
        {home.data && !bots.length ? <Text style={styles.note}>先新建一个 Bot</Text> : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { paddingHorizontal: 20, paddingVertical: 16, gap: 20 },
  field: { minHeight: 52, borderRadius: 26, paddingVertical: 12, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: colors.bubble },
  input: { fontSize: 17, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  problem: { color: colors.danger, fontSize: 14, marginTop: -8, marginLeft: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  name: { flex: 1, fontSize: 17 },
  note: { textAlign: 'center', color: colors.secondary, fontSize: 15 },
})
