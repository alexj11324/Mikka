import { Platform, Pressable, StyleSheet, useColorScheme, View } from 'react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'

/** The web build's segmented control, for screenshot checks (iOS draws the system's, Segmented.ios.tsx). */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  const dark = useColorScheme() === 'dark'
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map(option => (
        <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected: option.value === value }} {...(Platform.OS === 'web' ? { 'aria-selected': option.value === value } : {})} onPress={() => onChange(option.value)}
          style={[styles.segment, option.value === value && (dark ? styles.selectedDark : styles.selected)]}>
          <Text style={[styles.label, option.value !== value && styles.inactiveLabel]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: 2, borderRadius: 9, backgroundColor: colors.chip },
  segment: { flex: 1, minHeight: 44, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  selected: { backgroundColor: colors.surface },
  selectedDark: { backgroundColor: colors.pressed },
  label: { fontSize: 13, fontWeight: '600' },
  inactiveLabel: { color: colors.secondary },
})
