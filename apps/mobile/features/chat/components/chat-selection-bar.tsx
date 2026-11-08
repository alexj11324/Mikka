import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet } from 'react-native'
import Reanimated, { cubicBezier } from 'react-native-reanimated'
import { Text } from '@/components/Text'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { colors } from '@/lib/theme'
import { SELECTION_BAR, type SelectionAction } from '@/features/chat/model/chat-selection'
import { ChatGlassCapsule } from './chat-glass-capsule'

const EASE = cubicBezier(0.23, 1, 0.32, 1)
const DURATION = 200

/**
 * Text selected in a message (选择文本): a row of glass capsules just above the composer. 添加到对话 puts the
 * selection into the composer as its quote; each of the others is an instruction sent at once as a reply quoting it. The capsules rise in from the left, 30 ms apart; under
 * Reduce Motion only the glass fades. It stays mounted for the exit, then leaves.
 */
export function ChatSelectionBar({ visible, disabled, onAction }: { visible: boolean; disabled: boolean; onAction: (action: SelectionAction) => void }) {
  const reduceMotion = useReducedMotionPreference()
  const [mounted, setMounted] = useState(visible)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (visible) {
      setMounted(true)
      // One frame later, so the capsules have a starting state to move from.
      const frame = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = setTimeout(() => setMounted(false), DURATION)
    return () => clearTimeout(timer)
  }, [visible])
  if (!mounted) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" accessibilityLabel="选中文字的操作"
      accessibilityElementsHidden={!shown} importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      contentContainerStyle={styles.row} style={styles.bar}>
      {SELECTION_BAR.map((action, index) => (
        <Reanimated.View key={action.key} style={[
          { transform: [{ translateY: shown || reduceMotion ? 0 : 8 }, { scale: shown || reduceMotion ? 1 : 0.97 }] },
          { transitionProperty: 'transform', transitionDuration: reduceMotion ? 0 : DURATION, transitionDelay: shown && !reduceMotion ? index * 30 : 0, transitionTimingFunction: EASE },
        ]}>
          <ChatGlassCapsule label={action.label} hidden={!shown} disabled={disabled} onPress={() => onAction(action)}>
            <Text style={styles.label}>{action.label}</Text>
          </ChatGlassCapsule>
        </Reanimated.View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  // The composer's own side margin is 16; the capsules line up with its field.
  bar: { marginHorizontal: -16, flexGrow: 0 },
  row: { gap: 8, paddingHorizontal: 16, paddingBottom: 4, paddingTop: 2 },
  label: { fontSize: 15, fontWeight: '600', color: colors.ink },
})
