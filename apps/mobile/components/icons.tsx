import { useEffect, useRef } from 'react'
import { ActivityIndicator, Animated, Easing, Platform, View } from 'react-native'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { Cloud, LoaderCircle, Laptop, MessageCircle, Server } from 'lucide-react-native'
import type { MachineKind, Source, ThreadStatus } from '@/lib/types'
import { colors } from '@/lib/theme'
import { threadDot } from '@/lib/thread-icon'
import { useReducedMotionPreference } from '@/lib/reduced-motion'

/** The two-line menu mark from the frames (ChatGPT iOS). */
export function MenuIcon({ size = 22, color = colors.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
      <Path d="M4 8h16M4 16h10" />
    </Svg>
  )
}

/** Grey spinner for running work (colour is restrained). */
export function Spinner({ size = 18, color = colors.secondary }: { size?: number; color?: string }) {
  const turn = useRef(new Animated.Value(0)).current
  const reduceMotion = useReducedMotionPreference()
  useEffect(() => {
    turn.setValue(0)
    if (reduceMotion) return
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' }))
    loop.start()
    return () => { loop.stop(); turn.setValue(0) }
  }, [reduceMotion, turn])
  // iOS has its own (UIActivityIndicatorView, 20 pt); the drawn ring is for the web build only (native first, #1386).
  if (Platform.OS === 'ios') return <ActivityIndicator accessibilityLabel="正在加载" size="small" color={color} style={size === 20 ? null : { transform: [{ scale: size / 20 }], width: size, height: size }} />
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <Animated.View accessible accessibilityRole="progressbar" accessibilityLabel="正在加载" accessibilityState={{ busy: true }} style={{ width: size, height: size, transform: [{ rotate }] }}>
      <LoaderCircle size={size} color={color} strokeWidth={2} />
    </Animated.View>
  )
}

/**
 * A thread's status icon: a speech bubble with its state as a dot on the corner (R-52). A circle is always a task, so a
 * thread borrows none: 进行中 a pulsing grey dot, 等待你 orange, 受阻 red, 已解决 green, 空闲 a hollow ring. The icon's
 * label names the state, so the colour is never the only sign (R-87). A thread is never drawn with its bot's avatar.
 * `plain` drops the dot where a list's section already names the state (the 线程 list, Alex 2026-11-06).
 */
export function StatusIcon({ status, size = 18, plain = false }: { status: ThreadStatus; size?: number; plain?: boolean }) {
  const { dot, label } = threadDot(status)
  const pulse = useRef(new Animated.Value(1)).current
  const reduceMotion = useReducedMotionPreference()
  useEffect(() => {
    pulse.setValue(1)
    if (dot !== 'running' || reduceMotion) return
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
    ]))
    loop.start()
    return () => { loop.stop(); pulse.setValue(1) }
  }, [dot, pulse, reduceMotion])
  const spot = Math.max(6, Math.round(size * 0.4))
  const fill = dot === 'waiting' ? colors.orange : dot === 'blocked' ? colors.danger : dot === 'resolved' ? colors.success : dot === 'idle' ? colors.page : colors.secondary
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size }}>
      <MessageCircle size={size} color={colors.secondary} strokeWidth={2} />
      {plain ? null : <Animated.View testID={`thread-dot-${dot}`} style={{
        position: 'absolute', top: -1, right: -1, width: spot, height: spot, borderRadius: spot / 2, backgroundColor: fill,
        borderWidth: dot === 'idle' ? 1.5 : 2, borderColor: dot === 'idle' ? colors.secondary : colors.page,
        opacity: dot === 'running' ? pulse : 1,
      }} />}
    </View>
  )
}

export function MachineIcon({ machine, size = 13, color = colors.secondary }: { machine: MachineKind; size?: number; color?: string }) {
  const Icon = machine === 'cloud' ? Cloud : machine === 'laptop' ? Laptop : Server
  return <Icon size={size} color={color} strokeWidth={2} />
}

/** Each app's own coloured mark, not a tinted square (Alex 2026-10-27). */
export function SourceIcon({ source, size = 20 }: { source: Source | 'google'; size?: number }) {
  const props = { width: size, height: size, viewBox: '0 0 24 24' }
  switch (source) {
    case 'gmail':
      return (
        <Svg {...props}>
          <Path d="M2 6.5V18c0 .8.7 1.5 1.5 1.5H6V9.8z" fill="#4285F4" />
          <Path d="M22 6.5V18c0 .8-.7 1.5-1.5 1.5H18V9.8z" fill="#34A853" />
          <Path d="M6 9.8 12 14l6-4.2V4.9L12 9 6 4.9z" fill="#EA4335" />
          <Path d="M18 4.9v4.9l4-3.3v-.9c0-1.6-1.8-2.5-3.1-1.6z" fill="#FBBC04" />
          <Path d="M2 5.6v.9l4 3.3V4.9L5.1 4C3.8 3.1 2 4 2 5.6z" fill="#C5221F" />
        </Svg>
      )
    case 'github':
      return (
        <Svg {...props}>
          <Path fill={colors.ink} d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
        </Svg>
      )
    case 'slack':
      return (
        <Svg {...props}>
          <Path fill="#E01E5A" d="M5.04 15.17a2.53 2.53 0 0 1-2.52 2.52A2.53 2.53 0 0 1 0 15.17a2.53 2.53 0 0 1 2.52-2.52h2.52zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.31A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52z" />
          <Path fill="#36C5F0" d="M8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52zm0 1.27a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52z" />
          <Path fill="#2EB67D" d="M18.96 8.83a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52zm-1.27 0a2.53 2.53 0 0 1-2.52 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 15.17 0a2.53 2.53 0 0 1 2.52 2.52z" />
          <Path fill="#ECB22E" d="M15.17 18.96a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 15.17 24a2.53 2.53 0 0 1-2.52-2.52v-2.52zm0-1.27a2.53 2.53 0 0 1-2.52-2.52 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 15.17a2.53 2.53 0 0 1-2.52 2.52z" />
        </Svg>
      )
    case 'notion':
      return (
        <Svg {...props} fill="none" stroke={colors.ink} strokeWidth={1.8} strokeLinejoin="round">
          <Rect x={3.5} y={3.5} width={17} height={17} rx={3} />
          <Path d="M8.5 16.5v-9l7 9v-9" strokeLinecap="round" />
        </Svg>
      )
    case 'linear':
      return (
        <Svg {...props}>
          <Circle cx={12} cy={12} r={9.5} fill="#5E6AD2" />
          <Path d="M6 13.5l4.5 4.5M5.2 10l8.8 8.8M7 7l10 10M10 5.2l8.8 8.8" stroke="#fff" strokeWidth={1.3} strokeLinecap="round" />
        </Svg>
      )
    case 'google':
      return (
        <Svg {...props}>
          <Path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.2H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8.1z" />
          <Path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z" />
          <Path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7H2.1a11 11 0 0 0 0 9.9z" />
          <Path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z" />
        </Svg>
      )
    case 'googlecalendar':
      return (
        <Svg {...props}>
          <Rect x={3} y={3} width={18} height={18} rx={3} fill="#4285F4" />
          <Rect x={5.5} y={8} width={13} height={10.5} rx={1.5} fill="#fff" />
          <Path d="M9.6 11.2c.4-.5 1-.7 1.6-.5.9.3.9 1.6 0 1.9.9.2 1 1.7 0 2-.7.2-1.4 0-1.7-.6M14 11v4.4" stroke="#4285F4" strokeWidth={1.1} fill="none" strokeLinecap="round" />
        </Svg>
      )
  }
}

export { BOT_COLORS, BOT_PICKER_SHAPES } from '@/lib/bot-look'
/** A bot's avatar. It is a UI slot (docs/ui-overlay.md, 「iOS app」): the official build draws the hosted layer's avatar here. */
export { BotAvatar } from '@ui-slot/bot-avatar'
