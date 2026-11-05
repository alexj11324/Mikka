import { Pressable, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { holdComposer } from '@/lib/attach-sheet'
import { tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'
import type { ClipboardImage } from 'expo-clipboard'

export type AttachSource = 'camera' | 'library' | 'file'

/** The composer's 「+」, in the field's bottom row as in the Claude app: it opens the 相机 / 照片 / 文件 sheet (app/attach.tsx). */
export function AttachMenu({ images, onPick, onPasteImage }: { images: boolean; onPick: (source: AttachSource) => Promise<void>; onPasteImage?: (image: ClipboardImage) => Promise<void> }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="添加"
      onPress={() => { tap(); holdComposer({ images, pick: onPick, pasteImage: onPasteImage }); router.push('/attach') }}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.5 }]}>
      <Symbol name="plus" size={17} color={colors.ink} web={<Plus size={19} color={colors.ink} strokeWidth={2} />} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
})
