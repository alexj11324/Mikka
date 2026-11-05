import { forwardRef, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View, type ViewInstance } from 'react-native'
import Reanimated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { ClipboardPasteButton, isPasteButtonAvailable, type ClipboardImage } from 'expo-clipboard'
import { Camera, FileText, Image as ImageIcon, Plus } from 'lucide-react-native'
import type { AttachSource } from '@/components/AttachMenu'
import { Symbol, type SymbolName } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { colors } from '@/lib/theme'
import { CARD_PADDING, CARD_RADIUS, CARD_ROW, CARD_WIDTH, cardHeight, PLUS_FADE_END, PLUS_SIZE, rowWindow } from '@/features/chat/model/chat-attachment-card'
import { ChatGlass } from './chat-glass-capsule'

/** One spring for the card, open and closed: 320 ms, no overshoot. */
const SPRING = { duration: 320, dampingRatio: 1 }

/** The composer's 「+」: 40 pt round, its glyph fading out while the card it grows into opens. */
export const ChatAttachmentPlus = forwardRef<ViewInstance, { progress: ReturnType<typeof useSharedValue<number>>; disabled: boolean; onPress: () => void }>(function ChatAttachmentPlus({ progress, disabled, onPress }, ref) {
  const glyph = useAnimatedStyle(() => ({ opacity: interpolate(progress.get(), [0, PLUS_FADE_END], [1, 0], Extrapolation.CLAMP) }))
  return (
    <View ref={ref} collapsable={false}>
      <Pressable accessibilityRole="button" accessibilityLabel="添加" accessibilityState={{ disabled }} disabled={disabled} hitSlop={4}
        onPress={() => { tap(); onPress() }} style={({ pressed }) => [styles.plus, disabled && { opacity: 0.45 }, pressed && { opacity: 0.55 }]}>
        <Reanimated.View style={glyph}>
          <Symbol name="plus" size={19} color={colors.ink} web={<Plus size={22} color={colors.ink} strokeWidth={1.9} />} />
        </Reanimated.View>
      </Pressable>
    </View>
  )
})

type Option = { source: AttachSource; label: string; symbol: SymbolName; web: typeof Camera; image: boolean }
/** Bottom to top, the camera nearest the thumb. */
const OPTIONS: Option[] = [
  { source: 'camera', label: '相机', symbol: 'camera', web: Camera, image: true },
  { source: 'library', label: '照片', symbol: 'photo.on.rectangle', web: ImageIcon, image: true },
  { source: 'file', label: '文件', symbol: 'doc', web: FileText, image: false },
]

/**
 * The attachment card (#1408 Phase 3): the 「+」 grows into a glass card of 相机 · 照片 · 文件 (and 粘贴 when the
 * clipboard holds a picture), anchored on the 「+」's corner. The card's size springs from the 「+」 to the list, so its
 * corners and text never stretch; the rows fade in one after another from the bottom. A tap outside or a choice folds
 * it back into the 「+」; a choice opens its picker at once. It rides the keyboard with the composer.
 */
export function ChatAttachmentCard({ anchor, progress, images, onPick, onPasteImage, onClosed }: {
  anchor: { left: number; bottom: number }
  progress: ReturnType<typeof useSharedValue<number>>
  images: boolean
  onPick: (source: AttachSource) => void
  onPasteImage?: (image: ClipboardImage) => void
  onClosed: () => void
}) {
  const reduceMotion = useReducedMotionPreference()
  const [closing, setClosing] = useState(false)
  const paste = Boolean(isPasteButtonAvailable && onPasteImage && images)
  const rows = OPTIONS.length + (paste ? 1 : 0)
  const height = cardHeight(rows)
  useEffect(() => { progress.set(reduceMotion ? withTiming(1, { duration: 0 }) : withSpring(1, SPRING)) }, [progress, reduceMotion])
  const close = (then?: () => void) => {
    if (closing) return
    setClosing(true)
    then?.()
    const done = (finished?: boolean) => { 'worklet'; if (finished) scheduleOnRN(onClosed) }
    progress.set(reduceMotion ? withTiming(0, { duration: 0 }, done) : withSpring(0, SPRING, done))
  }
  const card = useAnimatedStyle(() => ({
    width: interpolate(progress.get(), [0, 1], [PLUS_SIZE, CARD_WIDTH]),
    height: interpolate(progress.get(), [0, 1], [PLUS_SIZE, height]),
    borderRadius: interpolate(progress.get(), [0, 1], [PLUS_SIZE / 2, CARD_RADIUS]),
  }))
  const content = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(progress.get(), [0, 1], [PLUS_SIZE / CARD_WIDTH, 1]) }] }))
  return (
    <>
      <Pressable accessible={false} importantForAccessibility="no" onPress={() => close()} style={styles.backdrop} />
      <Reanimated.View accessibilityViewIsModal style={[styles.card, { left: anchor.left, bottom: anchor.bottom }, card]}>
        <ChatGlass hidden={closing} style={[styles.glass, { height }]}>
          <Reanimated.View style={[styles.list, { height, transformOrigin: 'bottom left' }, content]}>
            {paste ? (
              <CardRow index={rows - 1} progress={progress}>
                <View style={styles.pasteRow}>
                  <ClipboardPasteButton style={styles.pasteButton} acceptedContentTypes={['image']} displayMode="iconAndLabel"
                    onPress={image => { if (image.type === 'image') close(() => onPasteImage?.(image)) }} />
                </View>
              </CardRow>
            ) : null}
            {[...OPTIONS].reverse().map(option => {
              const index = OPTIONS.indexOf(option)
              const disabled = option.image && !images
              return (
                <CardRow key={option.source} index={index} progress={progress}>
                  <Pressable accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ disabled }} disabled={disabled || closing}
                    onPressIn={tap} pressRetentionOffset={12} onPress={() => close(() => onPick(option.source))}
                    style={({ pressed }) => [styles.row, disabled && { opacity: 0.45 }, pressed && { transform: [{ scale: 0.97 }], opacity: 0.7 }]}>
                    <Symbol name={option.symbol} size={19} color={colors.ink} web={<option.web size={21} color={colors.ink} strokeWidth={1.9} />} />
                    <Text style={styles.label}>{option.label}</Text>
                  </Pressable>
                </CardRow>
              )
            })}
          </Reanimated.View>
        </ChatGlass>
      </Reanimated.View>
    </>
  )
}

function CardRow({ index, progress, children }: { index: number; progress: ReturnType<typeof useSharedValue<number>>; children: React.ReactNode }) {
  const [from, to] = rowWindow(index)
  const style = useAnimatedStyle(() => {
    const shown = interpolate(progress.get(), [from, to], [0, 1], Extrapolation.CLAMP)
    return { opacity: shown, transform: [{ translateY: (1 - shown) * 8 }] }
  })
  return <Reanimated.View style={style}>{children}</Reanimated.View>
}

/** Holds the card's progress and where it opens; the composer renders the 「+」 and, while open, the card. */
export function useAttachmentCard() {
  const progress = useSharedValue(0)
  const plus = useRef<ViewInstance>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  return { progress, plus, anchor, setAnchor }
}

const styles = StyleSheet.create({
  plus: { width: PLUS_SIZE, height: PLUS_SIZE, borderRadius: PLUS_SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  // Reaches far above the composer: a tap anywhere over the chat folds the card.
  backdrop: { position: 'absolute', left: 0, right: 0, bottom: 0, top: -4000 },
  card: { position: 'absolute', overflow: 'hidden', borderCurve: 'continuous', zIndex: 20 },
  glass: { position: 'absolute', left: 0, bottom: 0, width: CARD_WIDTH, borderRadius: CARD_RADIUS },
  list: { position: 'absolute', left: 0, bottom: 0, width: CARD_WIDTH, paddingVertical: CARD_PADDING },
  row: { minHeight: CARD_ROW, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  label: { fontSize: 16, color: colors.ink },
  pasteRow: { height: CARD_ROW, justifyContent: 'center', paddingHorizontal: 10 },
  pasteButton: { width: CARD_WIDTH - 20, height: 40 },
})
