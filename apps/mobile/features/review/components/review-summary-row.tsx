import { Pressable, StyleSheet, View } from 'react-native'
import { ChevronRight, GitPullRequest, GitMerge, TriangleAlert } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { isMerged, summaryLabel, summaryParts, type ReviewSummary } from '../model/review'

/**
 * A code task's one-line summary (R0, R2a): 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败 ›」, or 「3 个文件 +42 −7 ·
 * 运行中」 before a PR. The whole line is one button that opens the review (decisions/2026-11-08-1230). A non-code task
 * has no summary and shows no row. Text on the page, no box (no grey slabs, 2026-11-08); +/− and the failed mark in
 * their system colours.
 */
export function ReviewSummaryRow({ summary, onPress, compact, short }: { summary: ReviewSummary; onPress: () => void; compact?: boolean; short?: boolean }) {
  const p = summaryParts(summary, short)
  const merged = isMerged(summary)
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`审阅，${summaryLabel(summary)}`} onPress={onPress} hitSlop={4}
      style={({ pressed }) => [styles.row, compact && styles.compact, pressed && { opacity: 0.6 }]}>
      {summary.pr ? (merged ? <GitMerge size={16} color={colors.merged} strokeWidth={2} /> : <GitPullRequest size={16} color={colors.prOpen} strokeWidth={2} />) : null}
      <View style={styles.words}>
        {!p.pr && !p.files && !p.additions && !p.status && <Text style={styles.text}>审阅</Text>}
        {p.pr ? <><Text style={styles.text}>{p.pr}</Text><Text style={styles.dot}>·</Text></> : null}
        {p.files ? <Text style={styles.text}>{p.files}</Text> : null}
        {p.additions !== null && <Text style={[styles.text, { color: colors.success }]}>{p.additions}</Text>}
        {summary.deletions ? <Text style={[styles.text, { color: colors.danger }]}>{p.deletions}</Text> : null}
        {p.status ? (
          <>
            <Text style={styles.dot}>·</Text>
            {p.failed ? <TriangleAlert size={14} color={colors.danger} strokeWidth={2} /> : null}
            <Text style={[styles.text, styles.status, p.failed && { color: colors.danger }]} numberOfLines={1}>{p.status}</Text>
          </>
        ) : null}
      </View>
      <ChevronRight size={16} color={colors.tertiary} strokeWidth={2} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  compact: { minHeight: 36 },
  words: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', columnGap: 6, overflow: 'hidden' },
  text: { flexShrink: 0, fontSize: 15, lineHeight: 20, color: colors.text, fontVariant: ['tabular-nums'] },
  status: { flexShrink: 1, minWidth: 0 },
  dot: { fontSize: 15, lineHeight: 20, color: colors.tertiary },
})
