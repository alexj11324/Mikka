import { Alert, Platform } from 'react-native'
import { mobileMessages as messages } from './messages'

/** React Native Web has no Alert implementation. Use each platform's own modal and focus handling. */
export function showSystemAlert(title: string, message?: string) {
  if (Platform.OS === 'web') globalThis.alert(message ? `${title}\n${message}` : title)
  else Alert.alert(title, message)
}

export function confirmDestructiveAction(title: string, confirmLabel: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm(title)) onConfirm()
    return
  }
  Alert.alert(title, undefined, [
    { text: messages.Common.cancel, style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ])
}
