import { Host, Toggle } from '@expo/ui/swift-ui'
import { View } from 'react-native'

/**
 * A switch row of a grouped settings section: the system's own toggle with its label, drawn by SwiftUI, as in iOS
 * Settings and OpenBot. The web build draws the same row in React Native (SettingsSwitch.tsx).
 */
export function ToggleRowView({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <View style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 6, opacity: disabled ? 0.5 : 1 }}>
      <Host matchContents={{ vertical: true }} style={{ width: '100%' }}>
        <Toggle isOn={value} onIsOnChange={next => { if (!disabled) onChange(next) }} label={label} />
      </Host>
    </View>
  )
}
