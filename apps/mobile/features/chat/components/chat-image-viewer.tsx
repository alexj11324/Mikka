import { useEffect, useMemo, useState } from 'react'
import { Image, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, useWindowDimensions, View, type ImageURISource } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { File, Paths } from 'expo-file-system'
import { ArrowLeft, Share as ShareIcon, X } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { colors } from '@/lib/theme'
import { clampZoom, dismisses, DOUBLE_TAP_ZOOM, fittedRect, galleryRows, loadedAspect, MAX_ZOOM, PAGE_GAP, pageTurn, panBounds, type Rect } from '@/features/chat/model/chat-image-geometry'
import { ChatGlass } from './chat-glass-capsule'

const OPEN = { damping: 30, stiffness: 260, mass: 1 }
const CLOSE = { damping: 32, stiffness: 300, mass: 1, overshootClamping: true }
const PAGE = { damping: 36, stiffness: 300, mass: 1, overshootClamping: true }
const SETTLE = { damping: 34, stiffness: 320, mass: 1 }

export type ViewerRequest = { index: number; origin: Rect | null; radius: number; grid?: boolean }

/**
 * The full-screen picture viewer (#1408 Phase 3). The picture flies from its place in the chat to fit the screen
 * over a dark backdrop. Pinch zooms (1–4×, rubber-banded) around the fingers, a double tap zooms to 2.5× there or
 * back, a pan moves a zoomed picture; unzoomed, a sideways drag turns the page and an up or down drag closes it,
 * the backdrop thinning as it goes. A tap on the picture hides the chrome, a tap beside it closes. The chrome: close,
 * 「x / y」, share, and a strip of thumbnails to jump between pages. `grid` opens the message's pictures as a grid
 * first. Under Reduce Motion nothing flies: it fades and scales in.
 */
export function ChatImageViewer({ images, request, onClose }: { images: ImageURISource[]; request: ViewerRequest; onClose: () => void }) {
  const screen = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const reduceMotion = useReducedMotionPreference()
  const [grid, setGrid] = useState(Boolean(request.grid))
  const [page, setPage] = useState(request.index)
  const [aspects, setAspects] = useState<Record<number, number>>({})
  const [chrome, setChrome] = useState(true)
  const many = images.length > 1
  const fitted = useMemo(() => images.map((_, index) => fittedRect(aspects[index] ?? null, screen, insets, many)), [aspects, images, insets, many, screen])
  const step = screen.width + PAGE_GAP

  const progress = useSharedValue(0)
  const pageX = useSharedValue(-request.index * step)
  const current = useSharedValue(request.index)
  const drag = useSharedValue({ x: 0, y: 0 })
  const zoom = useSharedValue(1)
  const zoomStart = useSharedValue(1)
  const offset = useSharedValue({ x: 0, y: 0 })
  const offsetStart = useSharedValue({ x: 0, y: 0 })
  const mode = useSharedValue<'none' | 'pan' | 'page' | 'dismiss'>('none')
  const origin = useSharedValue<Rect | null>(grid ? null : request.origin)
  const target = useSharedValue<Rect>(fitted[request.index]!)
  useEffect(() => { target.set(fitted[page]!) }, [fitted, page, target])

  useEffect(() => {
    if (grid) { progress.set(withTiming(1, { duration: reduceMotion ? 0 : 200 })); return }
    progress.set(reduceMotion ? withTiming(1, { duration: 200 }) : withSpring(1, OPEN))
  // Opens once; the grid opens a page with its own fade.
  }, [])
  useEffect(() => { tap() }, [])

  const close = () => {
    'worklet'
    zoom.set(withTiming(1, { duration: 120 }))
    offset.set({ x: 0, y: 0 })
    const done = (finished?: boolean) => { 'worklet'; if (finished) scheduleOnRN(onClose) }
    // Only the page it opened on flies home; another fades out where it is.
    if (current.get() !== request.index) origin.set(null)
    progress.set(reduceMotion ? withTiming(0, { duration: 180 }, done) : withSpring(0, CLOSE, done))
  }
  const goTo = (index: number) => {
    'worklet'
    current.set(index)
    zoom.set(withTiming(1, { duration: 160 })); offset.set({ x: 0, y: 0 })
    pageX.set(reduceMotion ? withTiming(-index * step, { duration: 160 }) : withSpring(-index * step, PAGE))
    scheduleOnRN(setPage, index)
  }

  const pinch = Gesture.Pinch()
    .onStart(() => { zoomStart.set(zoom.get()); offsetStart.set(offset.get()); scheduleOnRN(setChrome, false) })
    .onUpdate(event => {
      const next = clampZoom(zoomStart.get() * event.scale)
      // Keep the point between the fingers under them.
      const fx = event.focalX - screen.width / 2, fy = event.focalY - screen.height / 2
      const ratio = next / zoomStart.get()
      offset.set({ x: fx - (fx - offsetStart.get().x) * ratio, y: fy - (fy - offsetStart.get().y) * ratio })
      zoom.set(next)
    })
    .onEnd(() => {
      const settled = Math.min(MAX_ZOOM, Math.max(1, zoom.get()))
      if (settled < 1.01) { zoom.set(withSpring(1, SETTLE)); offset.set(withSpring({ x: 0, y: 0 }, SETTLE)); return }
      const rect = target.get(), bounds = panBounds(rect, settled, screen)
      zoom.set(withSpring(settled, SETTLE))
      offset.set(withSpring({ x: Math.max(-bounds.x, Math.min(bounds.x, offset.get().x)), y: Math.max(-bounds.y, Math.min(bounds.y, offset.get().y)) }, SETTLE))
    })

  const pan = Gesture.Pan().minDistance(8).maxPointers(1)
    .onStart(event => {
      offsetStart.set(offset.get())
      if (zoom.get() > 1.01) mode.set('pan')
      else if (many && Math.abs(event.translationX) > Math.abs(event.translationY)) mode.set('page')
      else { mode.set('dismiss'); scheduleOnRN(tap) }
      scheduleOnRN(setChrome, false)
    })
    .onUpdate(event => {
      const m = mode.get()
      if (m === 'pan') offset.set({ x: offsetStart.get().x + event.translationX, y: offsetStart.get().y + event.translationY })
      else if (m === 'page') {
        const at = -current.get() * step + event.translationX
        const edge = (current.get() === 0 && event.translationX > 0) || (current.get() === images.length - 1 && event.translationX < 0)
        pageX.set(edge ? -current.get() * step + event.translationX * 0.3 : at)
      } else if (m === 'dismiss') drag.set({ x: event.translationX, y: event.translationY })
    })
    .onEnd(event => {
      const m = mode.get()
      if (m === 'pan') {
        const bounds = panBounds(target.get(), zoom.get(), screen)
        // Carries a fifth of a second of the finger's speed, then settles inside the picture's edges.
        const x = offset.get().x + event.velocityX * 0.2, y = offset.get().y + event.velocityY * 0.2
        offset.set(withSpring({ x: Math.max(-bounds.x, Math.min(bounds.x, x)), y: Math.max(-bounds.y, Math.min(bounds.y, y)) }, SETTLE))
      } else if (m === 'page') goTo(pageTurn(event.translationX, event.velocityX, step, current.get(), images.length))
      else if (m === 'dismiss') {
        if (dismisses(event.translationY, event.velocityY)) close()
        else { drag.set(withSpring({ x: 0, y: 0 }, SETTLE)); scheduleOnRN(setChrome, true) }
      }
      mode.set('none')
    })

  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDuration(250).maxDistance(24)
    .onEnd(event => {
      if (zoom.get() > 1.01) { zoom.set(withSpring(1, SETTLE)); offset.set(withSpring({ x: 0, y: 0 }, SETTLE)); return }
      const fx = event.x - screen.width / 2, fy = event.y - screen.height / 2
      const bounds = panBounds(target.get(), DOUBLE_TAP_ZOOM, screen)
      zoom.set(withSpring(DOUBLE_TAP_ZOOM, SETTLE))
      offset.set(withSpring({ x: Math.max(-bounds.x, Math.min(bounds.x, -fx * (DOUBLE_TAP_ZOOM - 1))), y: Math.max(-bounds.y, Math.min(bounds.y, -fy * (DOUBLE_TAP_ZOOM - 1))) }, SETTLE))
    })
  const singleTap = Gesture.Tap().maxDistance(10)
    .onEnd(event => {
      const rect = target.get(), scale = zoom.get()
      const inside = Math.abs(event.x - screen.width / 2 - offset.get().x) <= rect.width * scale / 2 && Math.abs(event.y - screen.height / 2 - offset.get().y) <= rect.height * scale / 2
      if (inside) scheduleOnRN(setChrome, value => !value)
      else close()
    })
  const gesture = Gesture.Race(Gesture.Simultaneous(pinch, pan), Gesture.Exclusive(doubleTap, singleTap))

  const backdrop = useAnimatedStyle(() => {
    const fade = 1 - Math.min(0.85, Math.abs(drag.get().y) / (screen.height * 0.4) * 0.85)
    return { opacity: progress.get() * fade }
  })
  const strip = useAnimatedStyle(() => ({ transform: [{ translateX: pageX.get() }] }))

  const share = async () => {
    tap()
    const source = images[page]
    if (!source?.uri) return
    if (Platform.OS === 'web') { window.open(source.uri, '_blank', 'noopener'); return }
    try {
      const file = await File.downloadFileAsync(source.uri, new File(Paths.cache, `mikka-image-${Date.now()}.jpg`), { headers: (source.headers ?? {}) as Record<string, string>, idempotent: true })
      await Share.share({ url: file.uri })
    } catch { await Share.share({ message: '图片暂时无法分享，请重试。' }) }
  }

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={() => close()}>
      <GestureHandlerRootView style={styles.fill}>
        <Reanimated.View style={[styles.backdrop, backdrop]} />
        {grid ? (
          <Gallery images={images} insets={insets} width={screen.width} onClose={() => close()} onOpen={index => {
            current.set(index); pageX.set(-index * step); setPage(index); origin.set(null); setGrid(false)
          }} />
        ) : (
          <>
            <GestureDetector gesture={gesture}>
              <View accessibilityViewIsModal accessible accessibilityRole={many ? 'adjustable' : 'image'} accessibilityLabel="图片" accessibilityValue={many ? { text: `第 ${page + 1} 张，共 ${images.length} 张` } : undefined}
                accessibilityActions={[{ name: 'escape' }, { name: 'magicTap' }, ...(many ? [{ name: 'increment' as const }, { name: 'decrement' as const }] : [])]}
                onAccessibilityAction={event => {
                  const name = event.nativeEvent.actionName
                  if (name === 'increment' && page < images.length - 1) goTo(page + 1)
                  else if (name === 'decrement' && page > 0) goTo(page - 1)
                  else if (name === 'escape' || name === 'magicTap') close()
                }}
                style={styles.fill}>
                <Reanimated.View style={[styles.fill, strip]}>
                  {images.map((source, index) => Math.abs(index - page) <= 2 ? (
                    <ViewerPage key={index} index={index} step={step} source={source} rect={fitted[index]!} active={index === page}
                      progress={progress} origin={index === request.index ? origin : null} radius={request.radius} drag={drag} zoom={zoom} offset={offset} reduceMotion={reduceMotion}
                      onAspect={aspect => setAspects(current => current[index] === aspect ? current : { ...current, [index]: aspect })} />
                  ) : null)}
                </Reanimated.View>
              </View>
            </GestureDetector>
            <Chrome visible={chrome} insets={insets} page={page} count={images.length} images={images} onClose={() => { tap(); close() }} onShare={() => void share()} onJump={index => { tap(); goTo(index) }} />
          </>
        )}
      </GestureHandlerRootView>
    </Modal>
  )
}

function ViewerPage({ index, step, source, rect, active, progress, origin, radius, drag, zoom, offset, reduceMotion, onAspect }: {
  index: number; step: number; source: ImageURISource; rect: Rect; active: boolean; progress: SharedValue<number>; origin: SharedValue<Rect | null> | null; radius: number
  drag: SharedValue<{ x: number; y: number }>; zoom: SharedValue<number>; offset: SharedValue<{ x: number; y: number }>; reduceMotion: boolean; onAspect: (aspect: number) => void
}) {
  const style = useAnimatedStyle(() => {
    const p = progress.get()
    const from = origin?.get()
    const live = active
    const d = live ? drag.get() : { x: 0, y: 0 }
    const shrink = live ? 1 - Math.min(0.2, Math.abs(d.y) / 1000) : 1
    const z = live ? zoom.get() : 1
    const o = live ? offset.get() : { x: 0, y: 0 }
    if (from && !reduceMotion && live) {
      const x = from.x + (rect.x - from.x) * p, y = from.y + (rect.y - from.y) * p
      const width = from.width + (rect.width - from.width) * p, height = from.height + (rect.height - from.height) * p
      return { left: x + index * step, top: y, width, height, borderRadius: radius + (16 - radius) * p, opacity: 1,
        transform: [{ translateX: d.x + o.x }, { translateY: d.y + o.y }, { scale: shrink * z }] }
    }
    return { left: rect.x + index * step, top: rect.y, width: rect.width, height: rect.height, borderRadius: 16, opacity: live ? p : 1,
      transform: [{ translateX: d.x + o.x }, { translateY: d.y + o.y }, { scale: shrink * z * (live && (reduceMotion || !from) ? 0.92 + 0.08 * p : 1) }] }
  })
  return (
    <Reanimated.View style={[styles.page, style]}>
      <Image source={source} resizeMode="cover" style={styles.fill} accessibilityIgnoresInvertColors
        onLoad={event => {
          const aspect = loadedAspect(event)
          if (aspect) onAspect(aspect)
          else if (source.uri) Image.getSize(source.uri, (width, height) => { if (width && height) onAspect(width / height) }, () => {})
        }} />
    </Reanimated.View>
  )
}

function Chrome({ visible, insets, page, count, images, onClose, onShare, onJump }: { visible: boolean; insets: { top: number; bottom: number }; page: number; count: number; images: ImageURISource[]; onClose: () => void; onShare: () => void; onJump: (index: number) => void }) {
  const hidden = !visible
  return (
    <>
      <View pointerEvents={hidden ? 'none' : 'box-none'} style={[styles.top, { top: insets.top + 8 }]}>
        <View style={styles.side}>
          <GlassIcon label="关闭" hidden={hidden} onPress={onClose}><Symbol name="xmark" size={18} color={colors.ink} web={<X size={22} color={colors.ink} strokeWidth={2.2} />} /></GlassIcon>
          {count > 1 ? <ChatGlass hidden={hidden} style={styles.count}><Text style={[styles.countText, hidden && styles.gone]}>{page + 1} / {count}</Text></ChatGlass> : null}
        </View>
        <GlassIcon label="分享" hidden={hidden} onPress={onShare}><Symbol name="square.and.arrow.up" size={18} color={colors.ink} web={<ShareIcon size={20} color={colors.ink} strokeWidth={2} />} /></GlassIcon>
      </View>
      {count > 1 ? (
        <View pointerEvents={hidden ? 'none' : 'box-none'} style={[styles.thumbs, { bottom: insets.bottom + 8 }, hidden && styles.gone]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
            {images.map((source, index) => (
              <Pressable key={index} accessibilityRole="button" accessibilityLabel={`第 ${index + 1} 张`} accessibilityState={{ selected: index === page }} onPress={() => onJump(index)}
                style={[styles.thumb, index !== page && styles.thumbOther]}>
                <Image source={source} resizeMode="cover" style={styles.fill} />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </>
  )
}

function GlassIcon({ label, hidden, onPress, children }: { label: string; hidden: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={hidden} hitSlop={4} onPress={onPress} accessibilityElementsHidden={hidden}
      style={({ pressed }) => pressed && { opacity: 0.55 }}>
      <ChatGlass hidden={hidden} interactive style={styles.icon}><View style={hidden && styles.gone}>{children}</View></ChatGlass>
    </Pressable>
  )
}

/** All the message's pictures, two square columns; an odd count starts with one across. A tile opens it in the viewer. */
function Gallery({ images, insets, width, onClose, onOpen }: { images: ImageURISource[]; insets: { top: number; bottom: number }; width: number; onClose: () => void; onOpen: (index: number) => void }) {
  const column = (width - 32 - 4) / 2
  return (
    <View style={[styles.fill, { backgroundColor: colors.page }]}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8 + 48 + 16, paddingBottom: insets.bottom + 24, paddingHorizontal: 16, gap: 4 }}>
        {galleryRows(images.length).map(row => (
          <View key={row[0]} style={styles.galleryRow}>
            {row.map(index => (
              <Pressable key={index} accessibilityRole="button" accessibilityLabel={`第 ${index + 1} 张`} onPress={() => { tap(); onOpen(index) }}
                style={({ pressed }) => [{ width: row.length === 1 ? width - 32 : column, height: column }, styles.tile, pressed && { opacity: 0.7 }]}>
                <Image source={images[index]!} resizeMode="cover" style={styles.fill} />
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
      <View style={[styles.top, { top: insets.top + 8 }]}>
        <GlassIcon label="返回" hidden={false} onPress={() => { tap(); onClose() }}><Symbol name="chevron.backward" size={18} color={colors.ink} web={<ArrowLeft size={22} color={colors.ink} strokeWidth={2} />} /></GlassIcon>
        <ChatGlass style={styles.count}><Text accessibilityRole="header" style={styles.countText}>{images.length} 张图片</Text></ChatGlass>
        <View style={styles.iconSpace} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  gone: { opacity: 0 },
  // A dark backdrop, never a blur imitation (DESIGN.md § Glass).
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.92)' },
  page: { position: 'absolute', overflow: 'hidden', borderCurve: 'continuous', backgroundColor: colors.bubble },
  top: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  icon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  iconSpace: { width: 48, height: 48 },
  count: { height: 48, borderRadius: 24, paddingHorizontal: 16, justifyContent: 'center' },
  countText: { fontSize: 15, fontWeight: '600', color: colors.ink },
  thumbs: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  thumbRow: { gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  thumb: { width: 40, height: 40, borderRadius: 8, overflow: 'hidden', backgroundColor: colors.bubble },
  thumbOther: { opacity: 0.5, transform: [{ scale: 0.82 }] },
  galleryRow: { flexDirection: 'row', gap: 4 },
  tile: { borderRadius: 10, overflow: 'hidden', backgroundColor: colors.bubble },
})
