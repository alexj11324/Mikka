import { ScrollView, StyleSheet, TextInput } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Check } from 'lucide-react-native'
import { NavBar } from '@/components/NavBar'
import { colors, font, LIST_INSET } from '@/lib/theme'
import { useBatch } from '../model/batch-store'

/**
 * R2b, 修改意见: the overall note 发给 Agent sends with the line comments, from the floating bar's 「写修改意见…」.
 * It is kept with the batch as it is typed; ✓ or a swipe down closes the sheet.
 */
export function NoteSheet() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const [batch, setBatch, scope] = useBatch(id)
  return (
    <>
      <NavBar sheet fade={false} title="修改意见" right={{ icon: 'checkmark', label: '完成', web: <Check size={20} color={colors.ink} />, onPress: () => router.back() }} />
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <TextInput editable={!!scope} value={batch.note} onChangeText={note => setBatch(current => ({ ...current, note }))} placeholder="写修改意见…" placeholderTextColor={colors.secondary}
          multiline autoFocus accessibilityLabel="修改意见" style={styles.input} />
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { paddingHorizontal: LIST_INSET, paddingVertical: 12 },
  input: { minHeight: 160, padding: 14, borderRadius: 14, borderCurve: 'continuous', backgroundColor: colors.bubble, fontFamily: font, fontSize: 17, lineHeight: 23, color: colors.text, textAlignVertical: 'top' },
})
