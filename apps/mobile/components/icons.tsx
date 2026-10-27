import { useEffect, useRef } from 'react'
import { Animated, Easing, View } from 'react-native'
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg'
import {
  Circle as CircleIcon, CircleAlert, CircleCheck, Cloud, GitMerge, GitPullRequest, GitPullRequestClosed,
  GitPullRequestDraft, LoaderCircle, Laptop, Server,
} from 'lucide-react-native'
import type { BotLook, Machine, Source, ThreadStatus } from '@/lib/mock'
import { colors } from '@/lib/theme'

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
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [turn])
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <LoaderCircle size={size} color={color} strokeWidth={2} />
    </Animated.View>
  )
}

/** A thread's status icon; a thread is never drawn with its bot's avatar (glossary). PR states use GitHub's colours. */
export function StatusIcon({ status, size = 18 }: { status: ThreadStatus; size?: number }) {
  switch (status) {
    case 'running': return <Spinner size={size} />
    case 'waiting': return <CircleIcon size={size} color={colors.secondary} strokeWidth={2} />
    case 'failed': return <CircleAlert size={size} color={colors.danger} strokeWidth={2} />
    case 'done': return <CircleCheck size={size} color={colors.success} strokeWidth={2} />
    case 'review': return <GitPullRequest size={size} color={colors.prOpen} strokeWidth={2} />
    case 'draft': return <GitPullRequestDraft size={size} color={colors.secondary} strokeWidth={2} />
    case 'merged': return <GitMerge size={size} color={colors.merged} strokeWidth={2} />
    case 'closed': return <GitPullRequestClosed size={size} color={colors.danger} strokeWidth={2} />
  }
}

export function MachineIcon({ machine, size = 13, color = colors.secondary }: { machine: Machine; size?: number; color?: string }) {
  const Icon = machine === 'cloud' ? Cloud : machine === 'laptop' ? Laptop : Server
  return <Icon size={size} color={color} strokeWidth={2} />
}

/** Each app's own coloured mark, not a tinted square (Alex 2026-10-27). */
export function SourceIcon({ source, size = 20 }: { source: Source; size?: number }) {
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
          <Path fill="#111" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
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
        <Svg {...props} fill="none" stroke="#111" strokeWidth={1.8} strokeLinejoin="round">
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
    case 'calendar':
      return (
        <Svg {...props}>
          <Rect x={3} y={3} width={18} height={18} rx={3} fill="#4285F4" />
          <Rect x={5.5} y={8} width={13} height={10.5} rx={1.5} fill="#fff" />
          <Path d="M9.6 11.2c.4-.5 1-.7 1.6-.5.9.3.9 1.6 0 1.9.9.2 1 1.7 0 2-.7.2-1.4 0-1.7-.6M14 11v4.4" stroke="#4285F4" strokeWidth={1.1} fill="none" strokeLinecap="round" />
        </Svg>
      )
  }
}

/** A bot's avatar: its blob in its colour, with one bright eye (a still bloub). */
export function BotAvatar({ look, size = 24 }: { look: BotLook; size?: number }) {
  const c = look.color
  const body = (() => {
    switch (look.shape) {
      case 'circle': return <Circle cx={12} cy={12} r={10} fill={c} />
      case 'squircle': return <Rect x={2.5} y={2.5} width={19} height={19} rx={6.5} fill={c} />
      case 'flower':
        return (
          <>
            {[0, 72, 144, 216, 288].map(a => {
              const r = (a - 90) * Math.PI / 180
              return <Circle key={a} cx={12 + 5.4 * Math.cos(r)} cy={12.4 + 5.4 * Math.sin(r)} r={5} fill={c} />
            })}
            <Circle cx={12} cy={12.4} r={6} fill={c} />
          </>
        )
      case 'cloud':
        return (
          <>
            <Circle cx={8} cy={13} r={6} fill={c} />
            <Circle cx={14} cy={9.5} r={6.5} fill={c} />
            <Circle cx={17} cy={14} r={5.5} fill={c} />
            <Rect x={4} y={13} width={17} height={6.5} rx={3.2} fill={c} />
          </>
        )
      case 'cat':
        return (
          <>
            <Path d="M3.6 10.5 4.6 3l6 4.3M20.4 10.5 19.4 3l-6 4.3" fill={c} stroke={c} strokeWidth={1.6} strokeLinejoin="round" />
            <Ellipse cx={12} cy={13.5} rx={9.4} ry={8} fill={c} />
          </>
        )
      case 'drop': return <Path d="M12 2.2c3.6 4.4 7.8 8.7 7.8 13a7.8 7.8 0 0 1-15.6 0c0-4.3 4.2-8.6 7.8-13z" fill={c} />
    }
  })()
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {body}
        <Ellipse cx={15.6} cy={8.6} rx={1.5} ry={2.3} fill="#fff" />
      </Svg>
    </View>
  )
}
