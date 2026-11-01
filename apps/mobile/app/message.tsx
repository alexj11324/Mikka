import { Pressable, StyleSheet, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { Copy, Reply, TextSelect } from 'lucide-react-native'
import { Row } from '@/components/settings'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { tap } from '@/lib/haptics'
import { heldMessage, REACTIONS } from '@/lib/message-actions'
import { colors } from '@/lib/theme'

/**
 * What a long press on a message offers, as a system sheet (Messages, Slack,
 * Claude): a row of reactions on a stored message, then 回复 quotes it in the composer, 复制 copies its words, 选择文本
 * opens them to select a part.
 */
export default function MessageActions() {
  const router = useRouter()
  const message = heldMessage()
  if (!message) return null
  const close = (then?: () => void) => { router.back(); then?.() }
  const react = message.react
  return (
    <View style={styles.sheet}>
      {react ? (
        <View style={styles.reactions}>
          {REACTIONS.map(emoji => (
            <Pressable key={emoji} accessibilityRole="button" accessibilityState={{ selected: react.current === emoji }} accessibilityLabel={emoji}
              onPress={() => close(() => { tap(); react.set(react.current === emoji ? null : emoji) })}
              style={({ pressed }) => [styles.emoji, react.current === emoji && styles.emojiOn, pressed && { opacity: 0.6 }]}>
              <Text style={styles.emojiText}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Group>
        <Row icon={<Symbol name="arrowshape.turn.up.left" size={18} web={<Reply size={20} color={colors.ink} />} />} label="回复" trailing={null}
          onPress={() => close(message.onQuote)} />
      </Group>
      <Group>
        <Row icon={<Symbol name="doc.on.doc" size={18} web={<Copy size={20} color={colors.ink} />} />} label="复制" trailing={null}
          onPress={() => close(() => { void Clipboard.setStringAsync(message.text); tap() })} />
        <Row icon={<Symbol name="character.cursor.ibeam" size={18} web={<TextSelect size={20} color={colors.ink} />} />} label="选择文本" trailing={null}
          onPress={() => { router.back(); router.push('/message-text') }} />
      </Group>
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.grouped, paddingHorizontal: 16, paddingTop: 24 },
  reactions: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: 26, padding: 6, marginBottom: 20 },
  emoji: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emojiOn: { backgroundColor: colors.bubble },
  emojiText: { fontSize: 26 },
})
