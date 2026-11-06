import { useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
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

// The same labels as messages/zh-CN.json; API values remain the shared shape/colour ids.
const shapeLabels: Record<string, string> = { cercle: '圆形', squircle: '圆角方', nuage: '云朵', goutte: '水滴', fleur: '花', chat: '猫' }
const colorLabels: Record<string, string> = {
  encre: '墨色', brun: '棕色', rouge: '红色', orange: '橙色', ambre: '琥珀色', vert: '绿色',
  turquoise: '青色', bleu: '蓝色', violet: '紫色', rose: '粉色', gris: '灰色', creme: '奶油色',
}

/**
 * 新建 Bot (Comma design 06), a form sheet from 对话's 新建: a name, a shape and a colour, as on the web
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
        left={{ icon: 'xmark', label: '取消', disabled: busy, web: <X size={20} color={colors.ink} />, onPress: () => router.back() }}
        right={{ icon: 'checkmark', label: busy ? '创建中' : '创建', disabled: !name.trim() || busy, busy, prominent: true, web: <Check size={20} color={colors.accent} strokeWidth={2.4} />, onPress: () => void create() }} />
      <ScrollView {...underBar} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <View style={styles.hero}><BotAvatar color={color} shape={shape} size={96} /></View>
        <Field style={styles.field}>
          <TextInput editable={!busy} value={name} onChangeText={setName} placeholder="名字" placeholderTextColor={colors.secondary} maxLength={60} autoFocus
            returnKeyType="done" onSubmitEditing={() => void create()} style={styles.input} accessibilityLabel="名字" />
        </Field>
        {problem ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.problem}>{problem}</Text> : null}
        <Text style={styles.label}>形状</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="形状" style={styles.panel}>
          {BOT_PICKER_SHAPES.map(item => (
            <Pressable key={item} accessibilityRole="radio" accessibilityState={{ checked: shape === item, disabled: busy }} aria-checked={Platform.OS === 'web' ? shape === item : undefined} aria-disabled={Platform.OS === 'web' ? busy : undefined} accessibilityLabel={shapeLabels[item]} disabled={busy} onPress={() => { tap(); setShape(item) }}
              style={[styles.choice, shape === item && styles.chosen]}>
              <BotAvatar color="gris" shape={item} size={30} />
            </Pressable>
          ))}
        </View>
        <Text style={styles.label}>颜色</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="颜色" style={styles.panel}>
          {Object.entries(BOT_COLORS).map(([id, hex]) => (
            <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: color === id, disabled: busy }} aria-checked={Platform.OS === 'web' ? color === id : undefined} aria-disabled={Platform.OS === 'web' ? busy : undefined} accessibilityLabel={colorLabels[id]} disabled={busy} onPress={() => { tap(); setColor(id) }}
              style={[styles.swatchRing, color === id && { borderColor: colors.accent }]}>
              <View style={[styles.swatch, { backgroundColor: hex }]} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { padding: 16, gap: 12 },
  hero: { alignItems: 'center', marginTop: 24, marginBottom: 16 },
  label: { marginTop: 4, marginLeft: 16, fontSize: 15, fontWeight: '600', color: colors.secondary },
  panel: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 6, padding: 10, borderRadius: 22, borderCurve: 'continuous', backgroundColor: colors.bubble },
  field: { minHeight: 52, borderRadius: 26, paddingVertical: 12, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: colors.bubble },
  input: { fontSize: 17, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  problem: { color: colors.danger, fontSize: 14, marginTop: -8, marginLeft: 4 },
  choice: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  chosen: { borderColor: colors.accent },
  swatchRing: { width: 48, height: 48, borderRadius: 24, borderWidth: 2.5, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 36, height: 36, borderRadius: 18 },
})
