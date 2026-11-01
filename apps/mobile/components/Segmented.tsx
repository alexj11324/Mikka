import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'

/** The web build's segmented control, for screenshot checks (iOS draws the system's, Segmented.ios.tsx). */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map(option => (
        <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected: option.value === value }} onPress={() => onChange(option.value)}
          style={[styles.segment, option.value === value && styles.selected]}>
          <Text style={styles.label}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: 2, borderRadius: 9, backgroundColor: '#E4E4E6' },
  segment: { flex: 1, height: 30, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  selected: { backgroundColor: colors.surface },
  label: { fontSize: 13, fontWeight: '600' },
})
