import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { ReadNotice } from '@/components/ReadNotice'
import { ModelMenu } from '@/components/ModelMenu'
import { modelStatusLine, type ModelMenuState } from '@/lib/model-menu'
import { colors } from '@/lib/theme'

/**
 * Above the composer: which pick did not save and why, with 重试 (Figma 843:2 #3); otherwise a line only when the
 * next message will go differently (quota out, model unavailable), never an always-on status (#1386).
 */
export function ModelNotice({ model }: { model: ModelMenuState }) {
  const { failure, choose, busy, choosing } = model
  if (!failure) {
    if (choosing) return <View accessibilityLiveRegion="polite" style={styles.notice}><Text style={[styles.line, { color: colors.secondary }]}>正在切换模型…</Text></View>
    if (model.refreshFailed || (model.readError && model.menu)) return <ReadNotice error={model.refreshFailed || model.readError} hasData={Boolean(model.menu)} label="模型" onRetry={model.refreshFailed ? model.refresh : model.retryRead} />
    const status = model.menu ? modelStatusLine(model.menu.current) : null
    // Only when the next message goes differently (#1386); 换模型 opens the same native model menu.
    return status ? <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
      <Text style={[styles.line, { color: colors.secondary }]}>{status.line}</Text>
      {status.change ? <ModelMenu model={model} label="换模型" /> : null}
    </View> : null
  }
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
      <Text style={styles.line}>{failure.line}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} aria-disabled={busy} aria-busy={busy} disabled={busy} style={styles.retryButton} onPress={() => void choose(failure.id)}>
        <Text style={styles.retry}>{busy ? '正在重试' : '重试'}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, marginBottom: 8 },
  line: { flexShrink: 1, fontSize: 13, lineHeight: 18, color: colors.danger },
  retryButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  retry: { fontSize: 13, lineHeight: 18, color: colors.accent },
})
