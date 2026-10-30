'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, registerExtraShapes, type BotColor, type BotShape } from '@/lib/bot-shapes'
import { cn } from '@/lib/utils'

export { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape }

/**
 * What the bot is doing, as bloub states (Figma 196:3571): 空闲 idle (its eyes
 * follow the cursor), 工作中 thinking, 等你处理 notify, 完成 wink, 出错
 * exclaim, 离线 sleep.
 */
export type BotMood = 'idle' | 'thinking' | 'notify' | 'wink' | 'exclaim' | 'sleep'

/** A steady colour for something that has a name but no colour of its own, such as an agent assignee. */
export function colorFor(name: string): BotColor {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0
  // Cream is left out: next to other avatars it reads as empty.
  return BOT_COLORS[Math.abs(hash) % (BOT_COLORS.length - 1)]
}

/** The Coordinator's look (Figma 202:4518): the default ink circle, no badge. */
export const COORDINATOR_AVATAR = { color: 'encre', shape: 'cercle' } as const

/**
 * The Coordinator is a bot like any other. Where the same slot can show the
 * Coordinator or a bot, render `BotAvatar` with `COORDINATOR_AVATAR` instead,
 * so switching keeps one mounted blob that morphs.
 */
export function CoordinatorAvatar({ size = 'list', mood }: { size?: keyof typeof SIZES; mood?: BotMood }) {
  return <BotAvatar {...COORDINATOR_AVATAR} size={size} mood={mood} />
}

type Runtime = [typeof import('@norbert_bodziony/bloub'), typeof import('@solidjs/web'), typeof import('solid-js')]
let runtime: Runtime | null = null
let loading: Promise<Runtime> | null = null
/** bloub and Solid load once per page and stay cached, so a remount draws its first frame at once. */
function loadRuntime(): Promise<Runtime> {
  loading ??= Promise.all([import('@norbert_bodziony/bloub'), import('@solidjs/web'), import('solid-js')]).then(loaded => {
    registerExtraShapes(loaded[0].SHAPE_BY_ID as unknown as Map<string, { id: string; radii: number[] }>)
    runtime = loaded
    return loaded
  })
  return loading
}
if (typeof window !== 'undefined') void loadRuntime()

/**
 * Idle plays a montage instead of one long idle block: rest (bloub blinks on
 * its own), a wink, rest, a wide-eyed glance. Other moods hold their state.
 */
function cycleFor(bloub: Runtime[0], mood: BotMood) {
  if (mood !== 'idle') return [{ state: mood, duration: 12 }]
  return ([['idle', 6], ['wink', 1.6], ['idle', 5], ['wide', 2.2]] as const).map(([state, seconds]) => ({ state, duration: bloub.clampDuration(state, seconds) }))
}

/** A steady start point per bot plus the page clock, so a remounted avatar continues where it was instead of restarting. */
function phaseFor(seed: string, length: number): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0
  const offset = (Math.abs(hash) % 1000) / 1000 * length
  return (offset + performance.now() / 1000) % length
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Visible blob sizes. bloub's svg is 1.58× the blob, so it overflows its box on purpose. */
const SIZES = { row: 16, pill: 22, search: 28, list: 34, cell: 40, profile: 72, hero: 144 } as const
const SVG_SCALE = 1.58

const pick = <T extends string>(value: string | null | undefined, options: readonly T[], fallback: T) => (options as readonly string[]).includes(value ?? '') ? value as T : fallback

type Live = { set: (next: { color: string; shape: string; mood: BotMood }) => void; dispose: () => void }

/**
 * A bot's avatar: the bloub blob (@norbert_bodziony/bloub) in the bot's shape
 * and colour. bloub is a SolidJS component, so it mounts once into its own
 * node with Solid's renderer and React only owns the box; colour, shape and
 * mood then flow in through Solid signals, so a change morphs the blob instead
 * of remounting it. Small rows and anything `still` hold one pose; the rest
 * animate at 30fps and pause off screen.
 */
export function BotAvatar({ color, shape, size = 'list', mood = 'idle', label, still = size === 'row' }: {
  color?: string | null; shape?: string | null; size?: keyof typeof SIZES; mood?: BotMood; label?: string; still?: boolean
}) {
  const host = useRef<HTMLSpanElement>(null)
  const live = useRef<Live | null>(null)
  const px = SIZES[size]
  const tone = pick(color, BOT_COLORS, DEFAULT_BOT_COLOR)
  const form = pick(shape, BOT_SHAPES, DEFAULT_BOT_SHAPE)
  // Ink would vanish on the dark page, so it turns cream there.
  const current = (): { color: string; shape: string; mood: BotMood } => ({ color: tone === 'encre' && document.documentElement.classList.contains('dark') ? 'creme' : tone, shape: form, mood })
  const latest = useRef(current)
  latest.current = current

  const seed = `${tone}:${form}`
  const latestSeed = useRef(seed)
  latestSeed.current = seed

  useLayoutEffect(() => {
    const node = host.current
    if (!node) return
    let alive = true
    const frozen = still || reducedMotion()
    const mount = ([bloub, { render, createComponent }, { createSignal }]: Runtime) => {
      if (!alive) return
      const first = latest.current()
      const [state, setState] = createSignal(first)
      const cycle = cycleFor(bloub, first.mood)
      const length = cycle.reduce((sum, block) => sum + block.duration, 0)
      const dispose = render(() => createComponent(bloub.BloubBot, {
        size: Math.round(px * SVG_SCALE), paper: 'transparent', ariaLabel: label ?? '', fps: 30,
        ...(frozen ? { frozenAt: 0 } : { initialPhase: phaseFor(latestSeed.current, length) }),
        get color() { return state().color },
        get shape() { return state().shape },
        get cycle() { return cycleFor(bloub, state().mood) },
        get follow() { return !frozen && state().mood === 'idle' },
      }), node)
      live.current = { set: next => setState(() => next), dispose }
    }
    if (runtime) mount(runtime)
    else void loadRuntime().then(mount)
    // Ink flips to cream when the theme changes.
    const watch = new MutationObserver(() => live.current?.set(latest.current()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => { alive = false; watch.disconnect(); live.current?.dispose(); live.current = null; node.replaceChildren() }
  }, [px, still, label])

  useEffect(() => { live.current?.set(latest.current()) }, [tone, form, mood])

  return <span ref={host} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-slot="bot-avatar" data-color={tone} data-shape={form}
    className={cn('relative inline-flex shrink-0 [&>svg]:absolute [&>svg]:top-1/2 [&>svg]:left-1/2 [&>svg]:max-w-none [&>svg]:-translate-1/2',
      // Buttons and sidebar rows size every svg inside them; the blob's svg keeps its own size (1.58× the box).
      size === 'row' && 'size-4 [&>svg]:size-6.5!', size === 'pill' && 'size-5.5 [&>svg]:size-9!', size === 'search' && 'size-7 [&>svg]:size-11!', size === 'list' && 'size-8.5 [&>svg]:size-13.5!',
      size === 'cell' && 'size-10 [&>svg]:size-16!', size === 'profile' && 'size-18 [&>svg]:size-28.5!', size === 'hero' && 'size-36 [&>svg]:size-57!')} />
}
