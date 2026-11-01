import { Pressable, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { holdComposer } from '@/lib/attach-sheet'
import { tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'

export type AttachSource = 'camera' | 'library' | 'file'

/** The composer's 「+」, in the field's bottom row as in the Claude app: it opens the 相机 / 照片 / 文件 sheet (app/attach.tsx). */
export function AttachMenu({ images, onPick }: { images: boolean; onPick: (source: AttachSource) => Promise<void> }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="添加" hitSlop={8}
      onPress={() => { tap(); holdComposer({ images, pick: onPick }); router.push('/attach') }}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.5 }]}>
      <Symbol name="plus" size={20} color={colors.ink} web={<Plus size={22} color={colors.ink} strokeWidth={2} />} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
})
