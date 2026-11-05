import { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { GlassButton } from '@/components/GlassButton'
import { colors } from '@/lib/theme'

/** A failed read keeps useful data visible and offers an explicit retry. */
export function ReadNotice({ error, hasData = false, label = '内容', onRetry }: {
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
    <Text style={styles.text}>{hasData ? `${label}更新失败，仍显示上次内容。` : `${label}加载失败。`}</Text>
    <GlassButton label="重试" busy={busy} onPress={() => void retry()} />
  </View>
}
const styles = StyleSheet.create({
  notice: { padding: 16, gap: 10, alignItems: 'flex-start' },
  text: { fontSize: 14, lineHeight: 20, color: colors.danger },
})
