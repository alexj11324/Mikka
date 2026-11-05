import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View, type ViewInstance } from 'react-native'
import { Gesture } from 'react-native-gesture-handler'
import Reanimated, { scrollTo, useAnimatedStyle, useFrameCallback, useSharedValue, type AnimatedRef, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { BotAvatar } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { press, tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'
import { dropOrder, type DropTarget } from '../model/home-list'
import type { HomeChat } from '../model/use-home-chats'

/** The hold before a move drags the chat; a move before it scrolls the list or swipes the row. */
const HOLD_MS = 250
/** A move this far before the hold is a scroll or a swipe, not a drag. */
const SCROLL_SLOP = 6
/** After the hold, a move this far starts the drag; iOS lets go of its menu at about the same distance. */
const DRAG_SLOP = 8
/** The band at the top and bottom of the list where a resting finger scrolls it. */
const EDGE = 72
/** The fastest edge scroll, in points per frame. */
const MAX_STEP = 14
const AVATAR = 40

/** Where a registered view lies, in list content coordinates (window y plus the scroll when measured). */
type Frame = { key: string; area: 'pins' | 'list'; x: number; y: number; w: number; h: number }

type Drag = {
  register: (key: string, area: 'pins' | 'list', view: ViewInstance | null) => void
  gesture: (key: string) => ReturnType<typeof Gesture.Pan>
  /** Whether a drag is on or has just ended: the press under it is not a tap. */
  active: () => boolean
}
const DragContext = createContext<Drag | null>(null)

/**
 * The home list's drag (#1408 Phase 2b). Holding a chat for 250 ms and then moving drags it: its avatar follows the
 * finger, a line marks where it will land, and the list scrolls while the finger rests near its top or bottom edge.
 * Dropping among the pins pins the chat or moves its pin; dropping in the list places it there and unpins it.
 */
export function ChatDragProvider({ chats, list, scroll, onDrop, children }: {
  chats: HomeChat[]
  list: AnimatedRef<Reanimated.FlatList<unknown>>
  scroll: SharedValue<number>
  onDrop: (order: { pinned: string[]; list: string[] }) => void
  children: ReactNode
}) {
  const views = useRef(new Map<string, { area: 'pins' | 'list'; view: ViewInstance }>())
  const frame = useRef<ViewInstance>(null)
  const frames = useSharedValue<Frame[]>([])
  const box = useSharedValue({ x: 0, y: 0, h: 0 })
  const finger = useSharedValue({ x: 0, y: 0 })
  const target = useSharedValue<DropTarget | null>(null)
  const active = useSharedValue(false)
  const [dragged, setDragged] = useState<HomeChat | null>(null)
  const dragging = useRef(false)
  const latest = useRef(chats)
  latest.current = chats

  const register = useCallback((key: string, area: 'pins' | 'list', view: ViewInstance | null) => {
    const id = `${area}:${key}`
    if (view) views.current.set(id, { area, view }); else views.current.delete(id)
  }, [])

  /** Measures the screen and every row and tile once, as the drag starts; the scroll offset carries them after. */
  const start = useCallback((key: string) => {
    dragging.current = true
    setDragged(latest.current.find(chat => chat.key === key) ?? null)
    press()
    const at = scroll.get()
    frame.current?.measureInWindow((x, y, _w, h) => { box.set({ x, y, h }) })
    const entries = [...views.current.entries()]
    const measured: Frame[] = []
    let left = entries.length
    for (const [id, { area, view }] of entries) {
      view.measureInWindow((x, y, w, h) => {
        if (w > 0 && h > 0) measured.push({ key: id.slice(area.length + 1), area, x, y: y + at, w, h })
        if (--left === 0) frames.set(measured.sort((a, b) => a.y - b.y || a.x - b.x))
      })
    }
  }, [box, frames, scroll])

  const finish = useCallback((key: string, landing: DropTarget | null) => {
    setTimeout(() => { dragging.current = false }, 0)
    setDragged(null)
    frames.set([])
    if (!landing) return
    const order = dropOrder(latest.current, key, landing)
    if (order) { tap(); onDrop(order) }
  }, [frames, onDrop])

  const gesture = useCallback((key: string) => {
    const began = { t: 0, x: 0, y: 0 }
    return Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown(event => {
        const touch = event.allTouches[0]
        if (!touch || event.numberOfTouches > 1) return
        began.t = Date.now(); began.x = touch.absoluteX; began.y = touch.absoluteY
      })
      .onTouchesMove((event, manager) => {
        const touch = event.allTouches[0]
        if (!touch) return
        const moved = Math.hypot(touch.absoluteX - began.x, touch.absoluteY - began.y)
        const held = Date.now() - began.t >= HOLD_MS
        if (!held && moved > SCROLL_SLOP) manager.fail()
        else if (held && moved > DRAG_SLOP) manager.activate()
      })
      .onTouchesUp((_event, manager) => { manager.end() })
      .onStart(event => {
        active.set(true)
        target.set(null)
        finger.set({ x: event.absoluteX, y: event.absoluteY })
        scheduleOnRN(start, key)
      })
      .onUpdate(event => {
        finger.set({ x: event.absoluteX, y: event.absoluteY })
        target.set(landingAt(frames.get(), key, event.absoluteX, event.absoluteY + scroll.get()))
      })
      .onEnd(() => { scheduleOnRN(finish, key, target.get()) })
      .onFinalize(() => { active.set(false); target.set(null) })
  }, [active, finger, finish, frames, scroll, start, target])

  // A finger resting near the list's top or bottom edge scrolls it, faster the closer it is.
  useFrameCallback(() => {
    if (!active.get()) return
    const { y: top, h } = box.get()
    const y = finger.get().y
    const near = y < top + EDGE ? -(top + EDGE - y) : y > top + h - EDGE ? y - (top + h - EDGE) : 0
    if (!near) return
    const next = Math.max(0, scroll.get() + Math.sign(near) * Math.min(MAX_STEP, Math.abs(near) / EDGE * MAX_STEP))
    scrollTo(list, 0, next, false)
    target.set(landingAt(frames.get(), '', finger.get().x, finger.get().y + next))
  })

  const avatar = useAnimatedStyle(() => ({
    opacity: active.get() ? 1 : 0,
    transform: [{ translateX: finger.get().x - box.get().x - AVATAR / 2 }, { translateY: finger.get().y - box.get().y - AVATAR / 2 }],
  }))
  const line = useAnimatedStyle(() => {
    const landing = target.get()
    const all = frames.get()
    if (!active.get() || !landing || landing.area !== 'list') return { opacity: 0 }
    const rows = all.filter(item => item.area === 'list')
    const before = landing.before === null ? null : rows.find(item => item.key === landing.before)
    const last = rows.at(-1)
    const y = before ? before.y : last ? last.y + last.h : 0
    return { opacity: 1, transform: [{ translateY: y - scroll.get() - box.get().y - 1 }] }
  })
  const pins = useAnimatedStyle(() => {
    const landing = target.get()
    const tiles = frames.get().filter(item => item.area === 'pins')
    if (!active.get() || !landing || landing.area !== 'pins' || !tiles.length) return { opacity: 0 }
    const top = Math.min(...tiles.map(t => t.y)), bottom = Math.max(...tiles.map(t => t.y + t.h))
    return { opacity: 1, height: bottom - top + 12, transform: [{ translateY: top - 6 - scroll.get() - box.get().y }] }
  })

  const isActive = useCallback(() => dragging.current, [])
  const value = useMemo(() => ({ register, gesture, active: isActive }), [gesture, isActive, register])
  return (
    <DragContext.Provider value={value}>
      <View ref={frame} style={styles.fill} collapsable={false}>
        {children}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Reanimated.View style={[styles.pinArea, pins]} />
          <Reanimated.View style={[styles.line, line]} />
          <Reanimated.View style={[styles.avatar, avatar]}>
            {dragged?.row.kind === 'bot' ? <BotAvatar color={dragged.row.bot.color} shape={dragged.row.bot.shape} size={AVATAR} />
              : dragged ? <View style={styles.group}><Symbol name="person.2.fill" size={17} color={colors.secondary} web={<Text style={styles.glyph}>群</Text>} /></View> : null}
          </Reanimated.View>
        </View>
      </View>
    </DragContext.Provider>
  )
}

/** Where the finger would drop: on a pin tile (before or after it), in the pin area, or before a list row. */
function landingAt(frames: Frame[], dragged: string, x: number, y: number): DropTarget | null {
  'worklet'
  const tiles = frames.filter(frame => frame.area === 'pins')
  const rows = frames.filter(frame => frame.area === 'list')
  if (tiles.length) {
    const top = Math.min(...tiles.map(t => t.y)), bottom = Math.max(...tiles.map(t => t.y + t.h))
    if (y >= top && y <= bottom) {
      const order = tiles.filter(t => t.key !== dragged)
      let index = order.length
      for (let i = 0; i < order.length; i++) {
        const t = order[i]!
        if (y < t.y + t.h && (y < t.y || x < t.x + t.w / 2)) { index = i; break }
      }
      return { area: 'pins', index }
    }
  }
  if (!rows.length || y < rows[0]!.y - 24) return null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    // Over the dragged chat's own place: it lands where it was, before the row after it.
    if (y < row.y + row.h / 2) return { area: 'list', before: row.key === dragged ? rows[i + 1]?.key ?? null : row.key }
  }
  return { area: 'list', before: null }
}

/** A row or tile's part in the drag: the view to measure, and the hold-and-move gesture that starts it. */
export function useChatDrag(key: string, area: 'pins' | 'list') {
  const drag = useContext(DragContext)
  const ref = useCallback((view: ViewInstance | null) => drag?.register(key, area, view), [area, drag, key])
  const gesture = useMemo(() => drag?.gesture(key) ?? Gesture.Pan().enabled(false), [drag, key])
  const active = useCallback(() => drag?.active() ?? false, [drag])
  return { ref, gesture, active }
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  avatar: { position: 'absolute', left: 0, top: 0, width: AVATAR, height: AVATAR, boxShadow: '0 6px 16px rgba(0, 0, 0, 0.25)', borderRadius: AVATAR / 2 },
  group: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 15, color: colors.secondary },
  line: { position: 'absolute', left: 20, right: 16, top: 0, height: 2, borderRadius: 1, backgroundColor: colors.accent },
  // An outline, so the pins stay in sight while the chat is held over them.
  pinArea: { position: 'absolute', left: 8, right: 8, top: 0, borderRadius: 18, borderCurve: 'continuous', borderWidth: 2, borderColor: colors.accent },
})
