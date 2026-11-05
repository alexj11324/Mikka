import { StyleSheet, View } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { RoundButton } from '@/components/ui'
import { colors } from '@/lib/theme'

/**
 * Back to the newest message, as in the Claude and ChatGPT apps: a round glass button with a down arrow, centred
 * just above the composer, only while the list is away from its end. `RoundButton` is the system's Liquid Glass on
 * iOS 26 and a white lifted circle on earlier iOS and the web, so it stands apart from the grey bubbles under it.
 */
export function ChatScrollToLatest({ visible, bottom, onPress }: { visible: boolean; bottom: number; onPress: () => void }) {
  if (!visible) return null
  return (
    <View pointerEvents="box-none" style={[styles.row, { bottom }]}>
      <RoundButton label="回到最新消息" onPress={onPress}>
        <Symbol name="arrow.down" size={17} color={colors.ink} web={<ArrowDown size={18} color={colors.ink} strokeWidth={2.2} />} />
      </RoundButton>
    </View>
  )
}
const styles = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
})
