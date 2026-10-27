import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, Ellipsis } from 'lucide-react-native'
import { SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { RoundButton } from '@/components/ui'
import { memoryMarkdown } from '@/lib/mock'
import { colors, font, lift } from '@/lib/theme'

/** Renders the small Markdown subset the summary uses: ## headings, - lists, paragraphs. */
function Markdown({ source }: { source: string }) {
  return (
    <View>
      {source.split('\n').map((line, i) => {
        if (line.startsWith('## ')) return <Text key={i} style={styles.h2}>{line.slice(3)}</Text>
        if (line.startsWith('- ')) return (
          <View key={i} style={styles.li}>
            <Text style={styles.text}>•</Text>
            <Text style={[styles.text, { flex: 1 }]}>{line.slice(2)}</Text>
          </View>
        )
        if (!line.trim()) return null
        return <Text key={i} style={styles.text}>{line}</Text>
      })}
    </View>
  )
}

/** 记忆摘要: one Markdown document with an ask-or-update input (ChatGPT 记忆摘要; Alex 2026-10-27). */
export default function MemorySummaryScreen() {
  const insets = useSafeAreaInsets()
  const [text, setText] = useState('')
  return (
    <SettingsPage
      title="记忆摘要"
      subtitle="更新于 12 分钟前"
      right={<RoundButton label="更多"><Ellipsis size={20} color={colors.ink} strokeWidth={2} /></RoundButton>}
      footer={
        <View style={[styles.askWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.ask}>
            <TextInput value={text} onChangeText={setText} placeholder="提问或更新" placeholderTextColor={colors.tertiary} style={styles.input} />
            <Pressable accessibilityRole="button" accessibilityLabel="发送" style={[styles.send, text.trim() ? { backgroundColor: colors.accent } : null]}>
              <ArrowUp size={20} color="#fff" strokeWidth={2.4} />
            </Pressable>
          </View>
        </View>
      }
    >
      <Markdown source={memoryMarkdown} />
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  h2: { fontSize: 19, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  text: { fontSize: 16, lineHeight: 26 },
  li: { flexDirection: 'row', gap: 8, paddingLeft: 4 },
  askWrap: { paddingHorizontal: 16, paddingTop: 8 },
  ask: { flexDirection: 'row', alignItems: 'center', height: 52, borderRadius: 26, backgroundColor: '#fff', paddingLeft: 18, paddingRight: 6, ...lift },
  input: { flex: 1, minWidth: 0, width: 0, fontFamily: font, fontSize: 16, outlineStyle: 'none' } as never,
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#B8B8BD', alignItems: 'center', justifyContent: 'center' },
})
