import { useState } from 'react'
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronDown, ChevronRight, ChevronUp, CircleCheck, CircleDot, FileCode2, GitMerge, GitPullRequest, Paperclip, TriangleAlert } from 'lucide-react-native'
import { CardButton } from '@/components/cards'
import { Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { shortWhen } from '@/lib/clock'
import { tap } from '@/lib/haptics'
import { useRefresh } from '@/lib/useApi'
import { colors, LIST_INSET, ROW_SURFACE_INSET, SPACE } from '@/lib/theme'
import { ReviewBar } from '../components/review-bar'
import { useReview } from '../components/use-review'
import { CANNOT_MERGE, CANNOT_SEND, checksLine, denial, sourceLine, toggleCheck, type ReviewCheck, type ReviewRead } from '../model/review'
import { batchHref, fileHref, noteHref } from '../model/routes'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

/**
 * R2, the iPhone review (#1738; decisions/2026-11-08-1230 7): one centred title, then the top row that matters — the
 * checks (tap to expand, a failing one can be 附到评论) and 批准合并, dark and neutral — then the changed files, and the
 * floating batch bar with 发给 Agent. Before a PR: 运行中 · 还没开 PR and a live diff (R6). After the merge: 已合并 (R8).
 * A teammate sees the actions off, with why (R11). No terminal, editor or file tree on iPhone.
 */
export function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const r = useReview(id)
  const refresh = useRefresh(r.reload)
  const [open, setOpen] = useState(false)
  const review = r.review
  const blocked = r.permissions && !r.permissions.canSend ? denial(r.permissions.reasons.send, CANNOT_SEND) : undefined

  return (
    <View style={styles.screen}>
      <NavBar title="审阅" />
      <ScrollView {...underBar} refreshControl={<RefreshControl {...refresh} />} contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 96 }]}>
        <ReadNotice error={r.error} hasData={Boolean(review)} label="审阅" onRetry={r.reload} />
        {r.loading && !review ? <View style={styles.center}><Spinner /></View> : null}
        {review ? (
          <>
            {sourceLine(review.diff.source, shortWhen) ? <Text style={styles.source}>{sourceLine(review.diff.source, shortWhen)}</Text> : null}
            <Top review={review} checks={r.checks} open={open} onToggle={() => { tap(); setOpen(value => !value) }}
              attached={r.batch.checks} onAttach={check => r.setBatch(batch => toggleCheck(batch, check.id))}
              merged={r.merged} merging={r.merging} onMerge={() => void r.approve()} />
            <Files review={review} onOpen={path => router.push(fileHref(id, path))} />
          </>
        ) : null}
      </ScrollView>
      {review && !r.merged ? <ReviewBar line={r.line} note={r.batch.note} canSend={r.canSend} busy={r.sending} blocked={blocked}
        onOpenBatch={() => router.push(batchHref(id))} onOpenNote={() => router.push(noteHref(id))} onSend={() => void r.send()} /> : null}
    </View>
  )
}

/** The top rows: the checks, expandable, and 批准合并 (or the running / merged state in its place). */
function Top({ review, checks: list, open, onToggle, attached, onAttach, merged, merging, onMerge }: {
  review: ReviewRead; checks: ReviewCheck[]; open: boolean; onToggle: () => void; attached: string[]; onAttach: (check: ReviewCheck) => void; merged: boolean; merging: boolean; onMerge: () => void
}) {
  const { checks } = review.summary
  const Chevron = open ? ChevronUp : ChevronDown
  const { permissions } = review.summary
  const failed = list.filter(check => check.status === 'failed')
  const others = list.filter(check => check.status !== 'failed')
  return (
    <View style={styles.top}>
      {list.length ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={checksLine(checks)} onPress={onToggle} style={({ pressed }) => [styles.checks, pressed && { opacity: 0.6 }]}>
          {checks.failed ? <TriangleAlert size={18} color={colors.danger} strokeWidth={2} /> : <CircleCheck size={18} color={colors.success} strokeWidth={2} />}
          <Text style={styles.checksText}>{checksLine(checks)}</Text>
          <Chevron size={18} color={colors.tertiary} strokeWidth={2} />
        </Pressable>
      ) : null}
      {open ? (
        <View style={styles.expanded}>
          {failed.map(check => {
            const on = attached.includes(check.id)
            return (
              <View key={check.id} style={styles.failed}>
                <View style={styles.checkHead}>
                  <TriangleAlert size={16} color={colors.danger} strokeWidth={2} />
                  <Text style={styles.checkName}>{check.name}</Text>
                </View>
                {check.logExcerpt ? <Text style={styles.log} numberOfLines={6} selectable>{check.logExcerpt}</Text> : null}
                <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => { tap(); onAttach(check) }} hitSlop={6} style={({ pressed }) => [styles.attach, pressed && { opacity: 0.6 }]}>
                  <Paperclip size={15} color={colors.accent} strokeWidth={2} />
                  <Text style={styles.attachText}>{on ? '已附到评论' : '附到评论'}</Text>
                </Pressable>
              </View>
            )
          })}
          {others.length ? <Text style={styles.passed}>{others.map(check => check.name).join(' · ')}</Text> : null}
        </View>
      ) : null}
      {merged ? (
        <View style={styles.state}><GitMerge size={18} color={colors.merged} strokeWidth={2} /><Text style={styles.stateText}>已合并</Text></View>
      ) : review.diff.empty ? null : !review.summary.pr ? (
        <View style={styles.state}><CircleDot size={18} color={colors.orange} strokeWidth={2} /><Text style={styles.stateText}>运行中 · 还没开 PR</Text>{review.diff.live ? <Text style={styles.live}>实时</Text> : null}</View>
      ) : (
        <View style={{ gap: 6 }}>
          <CardButton label="批准合并" primary hollow busy={merging} disabled={!permissions.canMerge} onPress={onMerge}
            icon={<GitPullRequest size={17} color={permissions.canMerge ? colors.onInk : colors.ink} strokeWidth={2} />} />
          {!permissions.canMerge ? <Text style={styles.reason}>{denial(permissions.reasons.merge, CANNOT_MERGE)}</Text> : null}
        </View>
      )}
    </View>
  )
}

/** The changed files: name, folder and comment count, +/−; a file too big to send at once loads on its own page. */
function Files({ review, onOpen }: { review: ReviewRead; onOpen: (path: string) => void }) {
  const { summary } = review
  if (review.diff.empty || !review.diff.files.length) return <Text style={styles.empty}>没有改动</Text>
  return (
    <View>
      <View style={styles.filesHead}>
        <Text style={styles.filesHeadText}>{summary.files} 个文件</Text>
        <Text style={[styles.filesHeadText, { color: colors.success }]}>+{summary.additions}</Text>
        <Text style={[styles.filesHeadText, { color: colors.danger }]}>−{summary.deletions}</Text>
      </View>
      {review.diff.files.map(file => {
        const slash = file.path.lastIndexOf('/')
        const name = file.path.slice(slash + 1)
        const folder = slash > 0 ? file.path.slice(0, slash) : ''
        const meta = [folder, file.comments ? `${file.comments} 条评论` : null].filter(Boolean).join(' · ')
        return (
          <Pressable key={file.path} accessibilityRole="button" accessibilityLabel={`${file.path}，+${file.additions} −${file.deletions}${file.tooLarge ? '，改动太大，点开加载' : ''}`} onPress={() => onOpen(file.path)}
            style={({ pressed }) => [styles.file, pressed && { backgroundColor: colors.pressed }]}>
            <FileCode2 size={20} color={colors.secondary} strokeWidth={1.8} />
            <View style={styles.fileText}>
              <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
              {meta ? <Text style={styles.fileMeta} numberOfLines={1}>{meta}</Text> : null}
              {file.tooLarge ? <Text style={styles.fileMeta}>改动太大，点开加载</Text> : null}
            </View>
            {file.additions ? <Text style={[styles.count, { color: colors.success }]}>+{file.additions}</Text> : null}
            {file.deletions ? <Text style={[styles.count, { color: colors.danger }]}>−{file.deletions}</Text> : null}
            <ChevronRight size={16} color={colors.tertiary} strokeWidth={2} />
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { paddingTop: 8 },
  center: { paddingTop: 40, alignItems: 'center' },
  source: { marginHorizontal: LIST_INSET, marginBottom: 8, fontSize: 14, color: colors.secondary },
  top: { paddingHorizontal: LIST_INSET, gap: 12, marginBottom: SPACE.section },
  checks: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  checksText: { flex: 1, fontSize: 16, color: colors.text },
  expanded: { gap: 12 },
  failed: { gap: 8 },
  checkHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkName: { fontSize: 15, fontWeight: '600', color: colors.text },
  log: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: colors.secondary },
  attach: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 32 },
  attachText: { fontSize: 15, color: colors.accent },
  passed: { fontSize: 14, color: colors.secondary },
  state: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  stateText: { fontSize: 16, color: colors.text },
  live: { fontSize: 13, color: colors.orange },
  reason: { fontSize: 14, color: colors.secondary, textAlign: 'center' },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  filesHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: LIST_INSET, paddingBottom: 6 },
  filesHeadText: { fontSize: 14, color: colors.secondary, fontVariant: ['tabular-nums'] },
  file: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: SPACE.rowMin, marginHorizontal: ROW_SURFACE_INSET, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET, borderRadius: 10 },
  fileText: { flex: 1, minWidth: 0, gap: SPACE.lineGap },
  fileName: { fontSize: 17, color: colors.text },
  fileMeta: { fontSize: 14, color: colors.secondary },
  count: { fontSize: 14, fontVariant: ['tabular-nums'] },
})
