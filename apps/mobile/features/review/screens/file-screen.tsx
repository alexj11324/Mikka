import { useMemo } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { useApi } from '@/lib/useApi'
import { colors, LIST_INSET } from '@/lib/theme'
import { ReviewBar } from '../components/review-bar'
import { useReview } from '../components/use-review'
import { CANNOT_SEND, denial, lineNumber, lineSide, parsePatch, type DiffLine, type PendingComment, type ReviewFileRead, type ReviewSentComment } from '../model/review'
import { filePath } from '../model/review-api'
import { batchHref, noteHref } from '../model/routes'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

/**
 * R3, one file's diff (#1738): a single column, each line with its number, added and removed lines washed green and
 * red. Comments sit under their line: sent ones from the conversation, pending ones from the batch (tap to edit or
 * delete). Tapping a line opens R3b to add one. The floating bar is the review's.
 */
export function FileScreen() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const r = useReview(id)
  const read = useApi<ReviewFileRead>(id && path ? filePath(id, path) : null)
  const file = read.data?.file ?? r.review?.diff.files.find(item => item.path === path)
  const hunks = useMemo(() => parsePatch(read.data?.file.patch ?? null), [read.data])
  const sentComments = read.data?.comments ?? []
  const name = path?.slice(path.lastIndexOf('/') + 1) ?? ''
  const pending = r.batch.comments.filter(comment => comment.path === path)
  const canComment = Boolean(r.permissions?.canSend) && !r.merged
  const openLine = (line: DiffLine) => {
    if (!canComment) return
    router.push({ pathname: '/task/[id]/comment', params: { id, path, line: String(lineNumber(line)), side: lineSide(line), quote: `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}` } })
  }
  const edit = (comment: PendingComment) => router.push({ pathname: '/task/[id]/comment', params: { id, path, line: String(comment.line), side: comment.side, quote: comment.quote, comment: comment.id } })

  return (
    <View style={styles.screen}>
      <NavBar title={name} />
      <ScrollView {...underBar} contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}>
        {file ? <Text style={styles.counts}><Text style={{ color: colors.success }}>+{file.additions}</Text>  <Text style={{ color: colors.danger }}>−{file.deletions}</Text>  <Text style={{ color: colors.secondary }}>{path}</Text></Text> : null}
        <ReadNotice error={read.error} hasData={Boolean(read.data)} label="改动" onRetry={read.reload} />
        {read.loading && !read.data ? <View style={styles.center}><Spinner /></View> : null}
        {hunks.map((hunk, h) => (
          <View key={h}>
            <Text style={styles.hunk} numberOfLines={1}>{hunk.header}</Text>
            {hunk.lines.map((line, index) => {
              const n = lineNumber(line), side = lineSide(line)
              const sent = sentComments.filter(comment => comment.line === n && comment.side === side)
              const mine = pending.filter(comment => comment.line === n && comment.side === side)
              return (
                <View key={index}>
                  <Pressable accessibilityRole={canComment ? 'button' : undefined} accessibilityLabel={`第 ${n} 行，${line.kind === 'add' ? '新增' : line.kind === 'del' ? '删除' : ''}${line.text}`}
                    onPress={() => openLine(line)} style={({ pressed }) => [styles.line, line.kind === 'add' && styles.add, line.kind === 'del' && styles.del, pressed && canComment && { opacity: 0.6 }]}>
                    <Text style={styles.number}>{n}</Text>
                    <Text style={styles.mark}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</Text>
                    <Text style={styles.code}>{line.text}</Text>
                  </Pressable>
                  {sent.map(comment => <CommentCard key={comment.id} comment={comment} />)}
                  {mine.map(comment => <CommentCard key={comment.id} comment={comment} onPress={() => edit(comment)} />)}
                </View>
              )
            })}
          </View>
        ))}
        {read.data && !hunks.length ? <Text style={styles.empty}>{read.data.file.tooLarge ? '改动太大，没法在手机上显示' : '没有改动'}</Text> : null}
      </ScrollView>
      {r.review && !r.merged ? <ReviewBar line={r.line} note={r.batch.note} canSend={r.canSend} busy={r.sending}
        blocked={r.permissions && !r.permissions.canSend ? denial(r.permissions.reasons.send, CANNOT_SEND) : undefined}
        onOpenBatch={() => router.push(batchHref(id))} onOpenNote={() => router.push(noteHref(id))} onSend={() => void r.send()} /> : null}
    </View>
  )
}

/** A comment under its line: who, which line and, for a pending one, 待发送; a pending one opens to edit. */
function CommentCard({ comment, onPress }: { comment: ReviewSentComment | PendingComment; onPress?: () => void }) {
  const sent = 'sentAt' in comment
  const body = (
    <>
      <View style={styles.cardHead}>
        <Text style={styles.who}>{sent ? comment.author : '你'}</Text>
        <Text style={styles.cardMeta}>第 {comment.line} 行{sent ? '' : ' · 待发送'}</Text>
      </View>
      <Text style={styles.cardBody}>{comment.body}</Text>
    </>
  )
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={`待发送的评论，第 ${comment.line} 行：${comment.body}`} onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}>{body}</Pressable>
    : <View style={styles.card}>{body}</View>
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  center: { paddingTop: 40, alignItems: 'center' },
  counts: { paddingHorizontal: LIST_INSET, paddingTop: 4, paddingBottom: 12, fontSize: 14, fontVariant: ['tabular-nums'] },
  hunk: { paddingHorizontal: LIST_INSET, paddingVertical: 6, fontFamily: MONO, fontSize: 12, color: colors.secondary },
  line: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 3, minHeight: 24 },
  add: { backgroundColor: colors.diffAdd },
  del: { backgroundColor: colors.diffDel },
  number: { width: 36, textAlign: 'right', fontFamily: MONO, fontSize: 12, lineHeight: 18, color: colors.tertiary },
  mark: { width: 16, textAlign: 'center', fontFamily: MONO, fontSize: 13, lineHeight: 18, color: colors.secondary },
  code: { flex: 1, fontFamily: MONO, fontSize: 13, lineHeight: 18, color: colors.text },
  card: { marginHorizontal: LIST_INSET - 8, marginVertical: 8, padding: 14, gap: 6, borderRadius: 14, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, backgroundColor: colors.page },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  who: { fontSize: 13, fontWeight: '600', color: colors.text },
  cardMeta: { fontSize: 13, color: colors.secondary },
  cardBody: { fontSize: 16, lineHeight: 22, color: colors.text },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
})
