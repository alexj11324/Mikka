import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Camera, FileText, Image as ImageIcon } from 'lucide-react-native'
import type { AttachSource } from '@/components/AttachMenu'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { CloseButton } from '@/components/ui'
import { heldComposer } from '@/lib/attach-sheet'
import { colors } from '@/lib/theme'
import { ClipboardPasteButton, isPasteButtonAvailable } from 'expo-clipboard'

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
  const mounted = useRef(true), focused = useRef(false), focusVersion = useRef(0), inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useFocusEffect(useCallback(() => {
    focused.current = true
    return () => { focused.current = false; focusVersion.current++ }
  }, []))
  if (!composer) return null
  const dismiss = () => {
    focused.current = false; focusVersion.current++
    if (router.canGoBack()) router.back()
    else router.replace('/chats')
  }
  const run = async (pick: () => Promise<void>) => {
    if (inFlight.current || !focused.current) return
    inFlight.current = true; setBusy(true); setProblem(null)
    const version = focusVersion.current
    try {
      await pick()
      // A slow picker or image conversion must not pop a screen opened after this sheet.
      if (mounted.current && focused.current && version === focusVersion.current && router.canGoBack()) router.back()
    } catch {
      if (mounted.current) setProblem('无法添加附件，请重新选择。')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <View style={styles.sheet}>
      {Platform.OS === 'web' ? <View style={styles.webHeader}>
        <Text accessibilityRole="header" style={styles.title}>添加附件</Text>
        <CloseButton onPress={dismiss} />
      </View> : null}
      <View style={styles.tiles}>
        {TILES.map(tile => {
          const disabled = busy || (tile.image && !composer.images)
          return (
            <Pressable key={tile.source} accessibilityRole="button" accessibilityState={{ disabled, busy }} disabled={disabled} onPress={() => void run(() => composer.pick(tile.source))}
              style={({ pressed }) => [styles.tile, pressed && { backgroundColor: colors.pressed }, disabled && { opacity: 0.4 }]}>
              <Symbol name={tile.symbol} size={24} web={<tile.web size={24} color={colors.ink} strokeWidth={1.8} />} />
              <Text style={styles.label}>{tile.label}</Text>
            </Pressable>
          )
        })}
        {isPasteButtonAvailable && composer.pasteImage && composer.images ? <View pointerEvents={busy ? 'none' : 'auto'} accessibilityState={{ disabled: busy, busy }} style={busy ? { opacity: 0.4 } : undefined}>
          <ClipboardPasteButton style={{ width: 84, height: 92 }} acceptedContentTypes={['image']} displayMode="iconAndLabel" onPress={image => { if (image.type === 'image') void run(() => composer.pasteImage!(image)) }} />
        </View> : null}
      </View>
      {busy ? <Text accessibilityLiveRegion="polite" style={styles.status}>正在处理附件…</Text> : null}
      {problem ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.problem}>{problem}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, gap: 10, backgroundColor: colors.grouped, paddingHorizontal: 16, paddingTop: 28 },
  webHeader: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 20, fontWeight: '600', color: colors.ink },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, height: 92, borderRadius: 18, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { fontSize: 15 },
  status: { fontSize: 13, color: colors.secondary },
  problem: { fontSize: 13, lineHeight: 18, color: colors.danger },
})
