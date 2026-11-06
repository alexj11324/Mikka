import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, View } from 'react-native'
import { GlassView } from 'expo-glass-effect'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { useLiquidGlass } from '@/lib/glass'
import { tap } from '@/lib/haptics'
import { colors, lift } from '@/lib/theme'

/** Space between the capsule and the tab bar. */
const GAP = 12
/** The room a list leaves under its last row so the capsule never covers it: the capsule, its gap and a margin. */
export const SWITCHER_SPACE = 52 + GAP + 40

export type ThreadFilter = 'all' | 'waiting' | 'running' | 'resolved'

const MARK = { width: 18, height: 18, borderRadius: 9 }

const OPTIONS: { id: ThreadFilter; label: string; mark: ReactNode }[] = [
  { id: 'all', label: '全部', mark: null },
  { id: 'waiting', label: '等待你', mark: <View style={[MARK, { backgroundColor: colors.orange }]} /> },
  { id: 'running', label: '进行中', mark: <View style={[MARK, { borderWidth: 2, borderColor: colors.secondary, overflow: 'hidden', flexDirection: 'row' }]}><View style={{ width: '50%', backgroundColor: colors.secondary }} /></View> },
  { id: 'resolved', label: '已解决', mark: <Symbol name="checkmark" size={17} color={colors.success} web={<Check size={20} color={colors.success} strokeWidth={2.4} />} /> },
]

/**
 * The floating status switcher over the 线程 list (Comma design 13; Alex 2026-11-06): 全部, 等待你, 进行中 and 已解决
 * in one Liquid Glass capsule above the tab bar, in place of the filter menu. Each mark has its word for VoiceOver.
 * It sits in a native safe-area view: inside a tab, the system counts the tab bar in that view's bottom inset, so the
 * capsule rests above the tab bar rather than on it, whatever its height.
 */
export function StatusSwitcher({ value, onChange }: { value: ThreadFilter; onChange: (value: ThreadFilter) => void }) {
  const glass = useLiquidGlass()
  const segments = (
    <View style={styles.row} accessibilityRole="tablist">
      {OPTIONS.map(option => {
        const selected = option.id === value
        return (
          <Pressable key={option.id} accessibilityRole="tab" accessibilityLabel={option.label} accessibilityState={{ selected }}
            {...(Platform.OS === 'web' ? { 'aria-selected': selected } : {})}
            onPress={() => { if (!selected) { tap(); onChange(option.id) } }}
            style={({ pressed }) => [styles.segment, selected && styles.selected, pressed && { opacity: 0.7 }]}>
            {option.mark ?? <Text style={styles.label}>{option.label}</Text>}
          </Pressable>
        )
      })}
    </View>
  )
  return (
    <SafeAreaView edges={['bottom']} mode="padding" pointerEvents="box-none" style={styles.place}>
      {glass ? <GlassView isInteractive style={styles.capsule}>{segments}</GlassView> : <View style={[styles.capsule, styles.lifted]}>{segments}</View>}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  place: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingTop: 0, marginBottom: GAP },
  capsule: { borderRadius: 26, padding: 4 },
  lifted: { backgroundColor: colors.surface, ...lift, shadowOpacity: 0.14, shadowRadius: 18 },
  row: { flexDirection: 'row', gap: 2 },
  segment: { minWidth: 56, height: 44, paddingHorizontal: 14, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  selected: { backgroundColor: colors.chip },
  label: { fontSize: 15, fontWeight: '600', color: colors.ink },
})
