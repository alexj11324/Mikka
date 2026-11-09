import { mobileMessages } from '@/lib/messages'
import { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { GlassButton } from '@/components/GlassButton'
import { colors } from '@/lib/theme'

/** A failed read keeps useful data visible and offers an explicit retry. */
export function ReadNotice({ error, hasData = false, label = mobileMessages.MobileCore.content, onRetry }: {
  error: unknown; hasData?: boolean; label?: string; onRetry: () => void | Promise<unknown>
}) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  if (!error) return null
  const retry = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { await onRetry() } catch { /* The screen retains the read error. */ }
    finally { pending.current = false; setBusy(false) }
  }
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
    <Text style={styles.text}>{(hasData ? mobileMessages.MobileCore.refreshFailed : mobileMessages.MobileCore.readFailed).replace('{label}', label)}</Text>
    <GlassButton label={mobileMessages.Common.retry} busy={busy} onPress={() => void retry()} />
  </View>
}
const styles = StyleSheet.create({
  notice: { padding: 16, gap: 10, alignItems: 'flex-start' },
  text: { fontSize: 14, lineHeight: 20, color: colors.danger },
})
