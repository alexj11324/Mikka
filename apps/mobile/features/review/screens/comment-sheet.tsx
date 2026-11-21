import { useState } from 'react'
import { Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { X } from 'lucide-react-native'
import { CardButton } from '@/components/cards'
import { NavBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { colors, font, LIST_INSET } from '@/lib/theme'
import { useBatch } from '../model/batch-store'
import { addComment, removeComment } from '../model/review'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

/**
 * R3b: a line's comment, as a sheet titled 「第 22 行」 with the line, an input and 加入评论 (dark, neutral), which puts
 * it in the review's batch. Opened on a pending comment it edits it and offers 删除. The sheet closes itself.
 */
export function CommentSheet() {
  const params = useLocalSearchParams<{ id: string; path: string; line: string; side: 'new' | 'old'; quote: string; comment?: string }>()
  const router = useRouter()
  const [batch, setBatch, scope] = useBatch(params.id)
  const existing = params.comment ? batch.comments.find(item => item.id === params.comment) : undefined
  const [body, setBody] = useState(existing?.body ?? '')
  const save = () => {
    if (!scope || !body.trim()) return
    tap()
    setBatch(current => addComment(current, { id: existing?.id ?? `${params.path}:${params.side}:${params.line}:${Date.now()}`, path: params.path, line: Number(params.line), side: params.side, body: body.trim(), quote: params.quote }))
    router.back()
  }
  const remove = () => { if (existing) { tap(); setBatch(current => removeComment(current, existing.id)) } router.back() }
  return (
    <>
      <NavBar sheet fade={false} title={`第 ${params.line} 行`} right={{ icon: 'xmark', label: '关闭', web: <X size={20} color={colors.ink} />, onPress: () => router.back() }} />
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Text style={styles.quote} numberOfLines={3}>{params.quote}</Text>
        <TextInput editable={!!scope} value={body} onChangeText={setBody} placeholder="写评论" placeholderTextColor={colors.secondary} multiline autoFocus
          accessibilityLabel={`第 ${params.line} 行的评论`} style={styles.input} />
        <CardButton label={existing ? '保存' : '加入评论'} primary disabled={!scope || !body.trim()} onPress={save} />
        {existing ? <View style={styles.delete}><CardButton label="删除" destructive onPress={remove} /></View> : null}
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { paddingHorizontal: LIST_INSET, paddingVertical: 12, gap: 16 },
  quote: { fontFamily: MONO, fontSize: 13, lineHeight: 18, color: colors.text, padding: 10, borderRadius: 10, backgroundColor: colors.diffAdd },
  input: { minHeight: 120, padding: 14, borderRadius: 14, borderCurve: 'continuous', backgroundColor: colors.bubble, fontFamily: font, fontSize: 17, lineHeight: 23, color: colors.text, textAlignVertical: 'top' },
  delete: { alignItems: 'center' },
})
