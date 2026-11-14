import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { z } from 'zod'
import { GlassButton } from '@/components/GlassButton'
import { Check, X } from 'lucide-react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { Field, Group } from '@/components/ui'
import { api, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { tap } from '@/lib/haptics'
import { mobileMessages } from '@/lib/messages'
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
  const { purpose } = useLocalSearchParams<{ purpose?: string }>()
  const standalone = purpose === 'conversation'
  const words = standalone ? mobileMessages.Shell.createConversation : mobileMessages.Shell.newGroup
  const bots = (home.data?.bots ?? []).filter(bot => standalone || !bot.coordinator)
  const pending = useRef(false)
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<'failed' | 'unconfirmed' | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const selected = picked.filter(id => bots.some(bot => bot.id === id))
  const ready = problem !== 'unconfirmed' && Boolean(title.trim() && selected.length && selected.length <= 100 && home.data)
  const create = async () => {
    if (!ready || pending.current || !home.data) return
    const context = apiCache.context()
    const current = () => mounted.current && context === apiCache.context()
    pending.current = true
    setBusy(true)
    setProblem(null)
    try {
      const group = await api<{ id: string; title: string }>('/api/conversations', { method: 'POST', body: {
        workspaceId: home.data.workspace.id, title: title.trim(),
        ...(standalone ? { purpose: 'conversation', leadBotId: selected[0] } : {}),
        members: selected.map(id => ({ memberType: 'bot', memberId: id })),
      } })
      if (!current()) return
      if (!z.uuid().safeParse(group?.id).success || typeof group?.title !== 'string') {
        setProblem('unconfirmed')
        return
      }
      tap()
      openChat(`/groups/${group.id}`)
    } catch (error) {
      if (current()) setProblem(error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 ? 'failed' : 'unconfirmed')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const toggle = (id: string) => { tap(); setPicked(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]) }
  return (
    <>
      <NavBar fade={false} title={words.title}
        left={{ icon: 'xmark', label: mobileMessages.Common.cancel, disabled: busy, web: <X size={20} color={colors.ink} />, onPress: () => router.back() }}
        right={{ icon: 'checkmark', label: busy ? mobileMessages.Common.loading : words.create, disabled: !ready || busy, busy, prominent: true, web: <Check size={20} color={colors.accent} strokeWidth={2.4} />, onPress: () => void create() }} />
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Field style={styles.field}>
          <TextInput editable={!busy && problem !== 'unconfirmed'} value={title} onChangeText={setTitle} placeholder={words.name} placeholderTextColor={colors.secondary} maxLength={200} autoFocus
            style={styles.input} accessibilityLabel={words.name} />
        </Field>
        {problem ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.problem}>{words[problem]}</Text> : null}
        {problem === 'unconfirmed' && <GlassButton label={words.reviewGroups} onPress={() => router.replace(standalone ? '/conversations' : '/')} />}
        <ReadNotice error={home.error} hasData={Boolean(home.data)} label={mobileMessages.Nav.bots} onRetry={home.reload} />
        {home.loading && !home.data ? <View style={{ alignItems: 'center', paddingVertical: 16 }}><Spinner /></View> : null}
        <Group label={words.bots} backgroundColor={colors.bubble}>
          {bots.map(bot => {
            const on = picked.includes(bot.id)
            const disabled = busy || problem === 'unconfirmed'
            return (
              <Pressable key={bot.id} accessibilityRole="checkbox" accessibilityLabel={bot.name} accessibilityState={{ checked: on, disabled }} aria-checked={Platform.OS === 'web' ? on : undefined} aria-disabled={Platform.OS === 'web' ? disabled : undefined} disabled={disabled} onPress={() => toggle(bot.id)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
                <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size={30} />
                <Text style={styles.name} numberOfLines={1}>{bot.name}</Text>
                {on ? <Symbol name="checkmark" size={19} color={colors.accent} web={<Check size={22} color={colors.accent} strokeWidth={2.2} />} /> : null}
              </Pressable>
            )
          })}
        </Group>
        {home.data && !bots.length ? <Text style={styles.note}>{words.noBots}</Text> : null}
      </ScrollView>
    </>
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
