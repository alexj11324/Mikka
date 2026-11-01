import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Check, X } from 'lucide-react-native'
import { BOT_COLORS, BOT_PICKER_SHAPES, BotAvatar } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { Field } from '@/components/ui'
import { api, ApiError } from '@/lib/api'
import { tap } from '@/lib/haptics'
import { useHome } from '@/lib/home'
import { chatPath, openChat } from '@/lib/navigate'
import { colors, font } from '@/lib/theme'

/**
 * 新建 Bot, from 对话's 「+」: a name, a shape and a colour, as on the web
 * (components/nav/new-bot-dialog.tsx); the bot's chat opens once it exists.
 */
export default function NewBot() {
  const router = useRouter()
  const home = useHome()
  const [name, setName] = useState('')
  const [shape, setShape] = useState<string>('cercle')
  const [color, setColor] = useState('encre')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const bot = await api<{ id: string }>('/api/mobile/bots', { method: 'POST', body: { name: name.trim(), color, shape } })
      tap()
      await home.reload()
      router.back()
      openChat(chatPath(bot.id))
    } catch (error) {
      setProblem(error instanceof ApiError && error.status === 409 ? '已有同名 Bot' : '没能创建')
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={styles.screen}>
      <NavBar title="新建 Bot"
        left={{ icon: 'xmark', label: '取消', web: <X size={20} color={colors.ink} />, onPress: () => router.back() }}
        right={{ icon: 'checkmark', label: '创建', web: <Check size={20} color={colors.ink} />, onPress: () => void create() }} />
      <ScrollView {...underBar} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <View style={styles.hero}><BotAvatar color={color} shape={shape} size={96} /></View>
        <Field style={styles.field}>
          <TextInput value={name} onChangeText={setName} placeholder="名字" placeholderTextColor={colors.tertiary} maxLength={60} autoFocus
            returnKeyType="done" onSubmitEditing={() => void create()} style={styles.input} accessibilityLabel="名字" />
        </Field>
        {problem ? <Text style={styles.problem}>{problem}</Text> : null}
        <View style={styles.grid}>
          {BOT_PICKER_SHAPES.map(item => (
            <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: shape === item }} accessibilityLabel={item} onPress={() => { tap(); setShape(item) }}
              style={[styles.choice, shape === item && styles.chosen]}>
              <BotAvatar color={color} shape={item} size={40} />
            </Pressable>
          ))}
        </View>
        <View style={styles.grid}>
          {Object.entries(BOT_COLORS).map(([id, hex]) => (
            <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: color === id }} accessibilityLabel={id} onPress={() => { tap(); setColor(id) }}
              style={[styles.swatchRing, color === id && { borderColor: hex }]}>
              <View style={[styles.swatch, { backgroundColor: hex }]} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.grouped },
  body: { padding: 16, gap: 20 },
  hero: { alignItems: 'center', marginTop: 8 },
  field: { height: 50, borderRadius: 14, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: colors.surface },
  input: { fontSize: 17, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  problem: { color: colors.danger, fontSize: 14, marginTop: -8, marginLeft: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center' },
  choice: { width: 60, height: 60, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  chosen: { borderWidth: 2, borderColor: colors.ink },
  swatchRing: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 30, height: 30, borderRadius: 15 },
})
