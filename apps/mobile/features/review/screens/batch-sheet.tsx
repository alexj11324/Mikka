import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Check, Paperclip, Trash2 } from 'lucide-react-native'
import { NavBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { colors, LIST_INSET } from '@/lib/theme'
import { useBatch } from '../model/batch-store'
import { useReview } from '../components/use-review'
import { removeComment, toggleCheck } from '../model/review'

/**
 * The pending batch, from the floating bar's 「N 条评论 · 失败检查 ›」: each line comment (tap to edit in R3b, or
 * delete) and the attached failing checks. The note is R2b's (note-sheet.tsx); the bar's 发给 Agent stays the one submit.
 */
export function BatchSheet() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const [batch, setBatch] = useBatch(id)
  const checks = useReview(id).checks
  return (
    <>
      <NavBar sheet fade={false} title="待发送" right={{ icon: 'checkmark', label: '完成', web: <Check size={20} color={colors.ink} />, onPress: () => router.back() }} />
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        {batch.comments.map(comment => (
          <View key={comment.id} style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel={`编辑 ${comment.path} 第 ${comment.line} 行的评论`} style={styles.rowText}
              onPress={() => router.push({ pathname: '/task/[id]/comment', params: { id, path: comment.path, line: String(comment.line), side: comment.side, quote: comment.quote, comment: comment.id } })}>
              <Text style={styles.where} numberOfLines={1}>{comment.path.slice(comment.path.lastIndexOf('/') + 1)}:{comment.line}</Text>
              <Text style={styles.text} numberOfLines={3}>{comment.body}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="删除" hitSlop={8} onPress={() => { tap(); setBatch(current => removeComment(current, comment.id)) }}>
              <Trash2 size={18} color={colors.danger} strokeWidth={2} />
            </Pressable>
          </View>
        ))}
        {batch.checks.map(check => (
          <View key={check} style={styles.row}>
            <Paperclip size={16} color={colors.secondary} strokeWidth={2} />
            <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>{`${checks.find(item => item.id === check)?.name ?? check} 失败`}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="移除" hitSlop={8} onPress={() => { tap(); setBatch(current => toggleCheck(current, check)) }}>
              <Trash2 size={18} color={colors.danger} strokeWidth={2} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { paddingHorizontal: LIST_INSET, paddingVertical: 12, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 },
  rowText: { flex: 1, gap: 4 },
  where: { fontSize: 13, color: colors.secondary },
  text: { fontSize: 16, color: colors.text },
})
