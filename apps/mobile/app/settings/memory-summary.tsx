import { useState } from 'react'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp } from 'lucide-react-native'
import { Markdown } from '@/components/Markdown'
import { SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { api } from '@/lib/api'
import { useSettings } from '@/lib/settings'
import { colors, font, lift } from '@/lib/theme'

/** 记忆摘要: one Markdown document with an ask-or-update input (ChatGPT 记忆摘要; Alex 2026-10-27). */
export default function MemorySummaryScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { data } = useSettings()
  const [text, setText] = useState('')
  // Asking or updating goes to the Coordinator, which keeps the memory; its answer is in the chat.
  const ask = async () => {
    const value = text.trim()
    if (!value) return
    await api('/api/mobile/chat', { method: 'POST', body: { text: `关于你记住的事：${value}` } })
    setText('')
    router.dismissTo('/')
  }
  return (
    <SettingsPage
      title="记忆摘要"
      footer={
        <View style={[styles.askWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.ask}>
            <TextInput value={text} onChangeText={setText} onSubmitEditing={() => void ask()} placeholder="提问或更新" placeholderTextColor={colors.tertiary} style={styles.input} />
            <Pressable accessibilityRole="button" accessibilityLabel="发送" onPress={() => void ask()} style={[styles.send, text.trim() ? { backgroundColor: colors.accent } : null]}>
              <ArrowUp size={20} color="#fff" strokeWidth={2.4} />
            </Pressable>
          </View>
        </View>
      }
    >
      {data?.memory ? <Markdown text={data.memory} /> : <Text style={styles.text}>还没有记住什么。</Text>}
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  text: { fontSize: 16, lineHeight: 26 },
  askWrap: { paddingHorizontal: 16, paddingTop: 8 },
  ask: { flexDirection: 'row', alignItems: 'center', height: 52, borderRadius: 26, backgroundColor: '#fff', paddingLeft: 18, paddingRight: 6, ...lift },
  input: { flex: 1, minWidth: 0, width: 0, fontFamily: font, fontSize: 16, outlineStyle: 'none' } as never,
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#B8B8BD', alignItems: 'center', justifyContent: 'center' },
})
