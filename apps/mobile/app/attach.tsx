import { Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Camera, FileText, Image as ImageIcon } from 'lucide-react-native'
import type { AttachSource } from '@/components/AttachMenu'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { heldComposer } from '@/lib/attach-sheet'
import { colors } from '@/lib/theme'

const TILES: { source: AttachSource; label: string; symbol: 'camera' | 'photo.on.rectangle' | 'doc'; web: typeof Camera; image: boolean }[] = [
  { source: 'camera', label: '相机', symbol: 'camera', web: Camera, image: true },
  { source: 'library', label: '照片', symbol: 'photo.on.rectangle', web: ImageIcon, image: true },
  { source: 'file', label: '文件', symbol: 'doc', web: FileText, image: false },
]

/**
 * The composer's 「+」 sheet, as in the Claude and ChatGPT apps: 相机, 照片
 * and 文件 as tiles. The picker opens over the sheet; once it closes, so does
 * the sheet, and what was picked waits in the composer.
 */
export default function AttachSheet() {
  const router = useRouter()
  const composer = heldComposer()
  if (!composer) return null
  const choose = async (source: AttachSource) => {
    await composer.pick(source)
    if (router.canGoBack()) router.back()
  }
  return (
    <View style={styles.sheet}>
      {TILES.map(tile => {
        const disabled = tile.image && !composer.images
        return (
          <Pressable key={tile.source} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => void choose(tile.source)}
            style={({ pressed }) => [styles.tile, pressed && { backgroundColor: colors.pressed }, disabled && { opacity: 0.4 }]}>
            <Symbol name={tile.symbol} size={24} web={<tile.web size={24} color={colors.ink} strokeWidth={1.8} />} />
            <Text style={styles.label}>{tile.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, flexDirection: 'row', gap: 10, backgroundColor: colors.grouped, paddingHorizontal: 16, paddingTop: 28 },
  tile: { flex: 1, height: 92, borderRadius: 18, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { fontSize: 15 },
})
