import { StyleSheet, Switch, View } from 'react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'

/** A switch row of a grouped settings section. On iOS it is the system's own toggle row (SettingsSwitch.ios.tsx). */
export function ToggleRowView({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <View style={[styles.row, disabled && { opacity: 0.5 }]}>
      <Text style={styles.label}>{label}</Text>
      <Switch accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} value={value} disabled={disabled} onValueChange={onChange}
        trackColor={{ true: colors.success, false: colors.chip }} thumbColor="#fff" {...{ activeThumbColor: '#fff' }} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, gap: 12, backgroundColor: colors.surface },
  label: { flex: 1, fontSize: 16, lineHeight: 21 },
})
