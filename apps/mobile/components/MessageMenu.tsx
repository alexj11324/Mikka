import { Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Ellipsis } from 'lucide-react-native'
import { holdMessage, type HeldMessage } from '@/lib/message-actions'
import { colors } from '@/lib/theme'

/**
 * ⋯ under a message (Alex 2026-11-08): its reactions, 回复, 复制 and 选择文本. Elsewhere than iOS (the web build) it
 * opens them as the actions sheet (app/message.tsx); iOS draws the system menu (MessageMenu.ios.tsx).
 */
export function MessageMenu({ message }: { message: HeldMessage }) {
  const router = useRouter()
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="更多" hitSlop={6} onPress={() => { holdMessage(message); router.push('/message') }}
      style={({ pressed }) => [styles.button, pressed && { backgroundColor: colors.pressed }]}>
      <Ellipsis size={14} color={colors.secondary} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // A 32-point button whose 6-point hitSlop keeps the 44-point target, as 复制 beside it.
  button: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
})
