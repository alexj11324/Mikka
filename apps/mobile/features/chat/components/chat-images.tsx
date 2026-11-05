import { useRef, useState } from 'react'
import { Image, Pressable, StyleSheet, useWindowDimensions, View, type ImageURISource, type ViewInstance } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { Images } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { SNAP_BACK } from '@/lib/springs'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { colors } from '@/lib/theme'
import { FRAME_RADIUS, frameSize, layerPose, loadedAspect, STACK_LIFT, STACK_SPREAD, stackCard, throwsCard } from '@/features/chat/model/chat-image-geometry'
import { ChatImageViewer, type ViewerRequest } from './chat-image-viewer'

const THROW = { damping: 30, stiffness: 260, mass: 1, overshootClamping: true }

/**
 * A message's pictures (#1408 Phase 3). One sits in a frame at its own shape; several are a stack of cards, the next
 * two fanned out behind (the other way for the person's own messages). Swiping the stack sideways throws the front
 * card to the back; a tap opens the full-screen viewer from that card, and 「N 张图片」 under the stack opens them all
 * as a grid. An empty `uri` is a picture still on its way: a grey card.
 */
export function ChatImages({ images, align = 'left' }: { images: ImageURISource[]; align?: 'left' | 'right' }) {
  const [viewer, setViewer] = useState<ViewerRequest | null>(null)
  if (!images.length) return null
  const open = (request: ViewerRequest) => { setViewer(request) }
  return (
    <View style={{ alignSelf: align === 'right' ? 'flex-end' : 'flex-start', alignItems: align === 'right' ? 'flex-end' : 'flex-start' }}>
      {images.length === 1 ? <Frame source={images[0]!} onOpen={open} /> : <Stack images={images} mirror={align === 'right'} onOpen={open} />}
      {viewer ? <ChatImageViewer images={images} request={viewer} onClose={() => setViewer(null)} /> : null}
    </View>
  )
}

function Frame({ source, onOpen }: { source: ImageURISource; onOpen: (request: ViewerRequest) => void }) {
  const screen = useWindowDimensions()
  const [aspect, setAspect] = useState<number | null>(null)
  const box = useRef<ViewInstance>(null)
  const size = frameSize(aspect, screen.width * 0.78)
  return (
    <Pressable ref={box} accessibilityRole="imagebutton" accessibilityLabel="图片" disabled={!source.uri}
      onPress={() => box.current?.measureInWindow((x, y, width, height) => onOpen({ index: 0, origin: { x, y, width, height }, radius: FRAME_RADIUS }))}
      style={({ pressed }) => [styles.frame, size, pressed && { opacity: 0.85 }]}>
      {source.uri ? <Image source={source} resizeMode="cover" style={styles.fill}
        onLoad={event => {
          const aspect = loadedAspect(event)
          if (aspect) setAspect(aspect)
          // The web load event does not carry the image's size. Read it from the file.
          else if (source.uri) Image.getSize(source.uri, (width, height) => { if (width && height) setAspect(width / height) }, () => {})
        }} /> : null}
    </Pressable>
  )
}

function Stack({ images, mirror, onOpen }: { images: ImageURISource[]; mirror: boolean; onOpen: (request: ViewerRequest) => void }) {
  const screen = useWindowDimensions()
  const card = stackCard(screen.width)
  const reduceMotion = useReducedMotionPreference()
  // The order of the cards, front first; a throw moves the front one to the back.
  const [order, setOrder] = useState(() => images.map((_, index) => index))
  const shown = order.filter(index => index < images.length)
  const front = useRef<ViewInstance>(null)
  const drag = useSharedValue(0)
  const thrown = useSharedValue(0)
  const rotate = () => { tap(); setOrder(current => [...current.slice(1), current[0]!]) }
  const half = card.width / 2
  const pan = Gesture.Pan().activeOffsetX([-12, 12]).failOffsetY([-12, 12]).maxPointers(1)
    .onUpdate(event => {
      const x = event.translationX
      drag.set(Math.sign(x) * half * (1 - 1 / (Math.abs(x) / half + 1)))
    })
    .onEnd(event => {
      if (throwsCard(event.translationX, event.velocityX, card.width)) {
        const side = Math.sign(event.translationX || event.velocityX) || 1
        const finish = (finished?: boolean) => { 'worklet'; if (finished) { drag.set(0); thrown.set(0); scheduleOnRN(rotate) } }
        thrown.set(side)
        drag.set(reduceMotion ? withTiming(0, { duration: 200 }, finish) : withSpring(0, { ...THROW, velocity: event.velocityX }, finish))
      } else drag.set(reduceMotion ? 0 : withSpring(0, { ...SNAP_BACK, velocity: event.velocityX }))
    })
  const openFront = () => front.current?.measureInWindow((x, y, width, height) => onOpen({ index: shown[0]!, origin: { x, y, width, height }, radius: FRAME_RADIUS }))
  const tapGesture = Gesture.Tap().maxDistance(10).onEnd(() => { scheduleOnRN(openFront) })
  const frontStyle = useAnimatedStyle(() => {
    // A throw arcs the card out to the side while it returns to the centre; past halfway it goes behind the others.
    const arc = thrown.get() ? Math.sin(Math.PI * (1 - Math.abs(drag.get()) / half)) * half * thrown.get() : 0
    const x = drag.get() + arc
    return { transform: [{ translateX: x }, { rotate: `${(x / half) * 10}deg` }] }
  })
  return (
    <View>
      <GestureDetector gesture={Gesture.Exclusive(pan, tapGesture)}>
        <View accessible accessibilityRole="adjustable" accessibilityLabel={`${images.length} 张图片`} accessibilityValue={{ text: `第 1 张，共 ${images.length} 张` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
          onAccessibilityAction={event => {
            const name = event.nativeEvent.actionName
            if (name === 'increment') rotate()
            else if (name === 'decrement') setOrder(current => [current.at(-1)!, ...current.slice(0, -1)])
            else openFront()
          }}
          style={{ width: card.width + STACK_SPREAD * 2, height: card.height + STACK_LIFT, alignItems: 'center' }}>
          {shown.slice(0, 4).map((index, depth) => ({ index, depth })).reverse().map(({ index, depth }) => {
            const pose = layerPose(depth, mirror)
            const layer = (
              <View key={index} style={[styles.card, card, { opacity: pose.opacity, transform: [{ translateX: pose.x }, { translateY: pose.y }, { rotate: `${pose.rotate}deg` }, { scale: pose.scale }] }]}>
                {images[index]!.uri ? <Image source={images[index]!} resizeMode="cover" style={styles.fill} /> : null}
              </View>
            )
            return depth === 0
              ? <Reanimated.View key={index} ref={front} collapsable={false} style={[styles.layer, frontStyle]}>{layer}</Reanimated.View>
              : <View key={index} style={styles.layer}>{layer}</View>
          })}
        </View>
      </GestureDetector>
      <Pressable accessibilityRole="button" accessibilityLabel={`查看全部 ${images.length} 张图片`} hitSlop={8} onPress={() => { tap(); onOpen({ index: 0, origin: null, radius: 10, grid: true }) }}
        style={({ pressed }) => [styles.count, { alignSelf: mirror ? 'flex-end' : 'flex-start' }, pressed && { opacity: 0.55 }]}>
        <Symbol name="photo.on.rectangle" size={12} color={colors.secondary} web={<Images size={14} color={colors.secondary} strokeWidth={2} />} />
        <Text style={styles.countText}>{images.length} 张图片</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  frame: { borderRadius: FRAME_RADIUS, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: colors.bubble },
  layer: { position: 'absolute', top: STACK_LIFT / 2, left: STACK_SPREAD, right: STACK_SPREAD, alignItems: 'center' },
  card: { borderRadius: FRAME_RADIUS, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: colors.bubble, boxShadow: '0 4px 16px rgba(0,0,0,0.22)' },
  count: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28, marginHorizontal: 11, marginTop: 4 },
  countText: { fontSize: 12, color: colors.secondary },
})
