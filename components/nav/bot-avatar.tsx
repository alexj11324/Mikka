'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, registerExtraShapes, type BotColor, type BotShape } from '@/lib/bot-shapes'
import { cn } from '@/lib/utils'

export { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape }

/**
 * What the bot is doing, as bloub states (Figma 196:3571): 空闲 idle (it plays
 * its own animations), 工作中 thinking, 等你处理 notify, 完成 wink, 出错
 * exclaim, 离线 sleep.
 * The rest are one-off moves (wide eyes, play, the hexagon pose, and the
 * burst, orbit and comet effects) for moments like the first-run guide; they
 * play at bloub's own length and the caller sets the mood back to idle afterwards.
 */
export type BotMood = 'idle' | 'thinking' | 'notify' | 'wink' | 'exclaim' | 'sleep' | BotMove

export type BotMove = 'wide' | 'play' | 'hexagon' | 'burst' | 'orbit' | 'comet'

/** How long each mood lasts at bloub's own pace, in seconds. */
export const BOT_MOOD_SECONDS: Record<BotMood, number> = { idle: 2.4, thinking: 2.6, notify: 2.2, wink: 1.6, exclaim: 2, sleep: 2.4, wide: 1.8, play: 2, hexagon: 1.6, burst: 2.6, orbit: 3.4, comet: 2.4 }
const BOT_MOVES = new Set<BotMood>(['wide', 'play', 'hexagon', 'burst', 'orbit', 'comet'])

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

type BloubBotRef = import('@norbert_bodziony/bloub').BloubBotRef
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
 * Idle plays bloub's own animations on its own, with no cursor following
 * (Alex: 「它自己动就行了」): short rests (bloub blinks by itself) between the
 * shape changes, glances and effects. The status states (thinking, notify,
 * exclaim, sleep) stay out, so they keep meaning 工作中 / 等你处理 / 出错 / 离线.
 * Other moods hold their state.
 */
const IDLE_MONTAGE = [
  ['idle', 3], ['egg', 1.8], ['idle', 2.5], ['wink', 1.6], ['idle', 2.5], ['hexagon', 1.6],
  ['idle', 2.5], ['wide', 1.8], ['idle', 2.5], ['play', 2], ['idle', 2.5], ['orbit', 3.4],
  ['idle', 2.5], ['comet', 2.6], ['idle', 2.5], ['burst', 2.4],
] as const

function cycleFor(bloub: Runtime[0], mood: BotMood, brisk: boolean) {
  if (BOT_MOVES.has(mood) || brisk && mood !== 'idle') return [{ state: mood, duration: bloub.clampDuration(mood, BOT_MOOD_SECONDS[mood]) }]
  if (mood !== 'idle') return [{ state: mood, duration: 12 }]
  return IDLE_MONTAGE.map(([state, seconds]) => ({ state, duration: bloub.clampDuration(state, seconds) }))
}

/**
 * Where a cycle of this length stands for this bot right now: a steady start
 * point per bot plus the page clock. Every avatar of the same bot reads the same
 * value, so the chat header, the list row and the panel show the same pose.
 */
function phaseFor(seed: string, length: number): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0
  const offset = (Math.abs(hash) % 1000) / 1000 * length
  return (offset + performance.now() / 1000) % length
}

const RESYNC_EVENT = 'mikka:bot-avatar-resync'

/** The block and the offset inside it for a phase, as bloub's `seek` takes them. */
function blockAt(cycle: { duration: number }[], phase: number) {
  let index = 0, rest = phase
  while (index < cycle.length - 1 && rest >= cycle[index].duration) rest -= cycle[index++].duration
  return { index, offset: rest }
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Visible blob sizes. bloub's svg is 1.58× the blob, so it overflows its box on purpose. */
const SIZES = { row: 16, pill: 22, search: 28, list: 34, cell: 40, profile: 72, hero: 144 } as const
const SVG_SCALE = 1.58

const pick = <T extends string>(value: string | null | undefined, options: readonly T[], fallback: T) => (options as readonly string[]).includes(value ?? '') ? value as T : fallback

type Live = { set: (next: { color: string; shape: string; mood: BotMood }) => void; resync: () => void; dispose: () => void }

/**
 * A bot's avatar: the bloub blob (@norbert_bodziony/bloub) in the bot's shape
 * and colour. bloub is a SolidJS component, so it mounts once into its own
 * node with Solid's renderer and React only owns the box; colour, shape and
 * mood then flow in through Solid signals, so a change morphs the blob instead
 * of remounting it. Small rows and anything `still` hold one pose; the rest
 * animate at 30fps and pause off screen.
 */
export function BotAvatar({ color, shape, size = 'list', mood = 'idle', label, still = size === 'row', brisk = false }: {
  color?: string | null; shape?: string | null; size?: keyof typeof SIZES; mood?: BotMood; label?: string; still?: boolean; brisk?: boolean
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
      const cycle = cycleFor(bloub, first.mood, brisk)
      const length = cycle.reduce((sum, block) => sum + block.duration, 0)
      let player: BloubBotRef | null = null
      const dispose = render(() => createComponent(bloub.BloubBot, {
        size: Math.round(px * SVG_SCALE), paper: 'transparent', ariaLabel: label ?? '', fps: 30,
        // bloub only moves through the montage while `playing`; without it an avatar stays on the block it mounted in.
        ...(frozen ? { frozenAt: 0 } : { initialPhase: phaseFor(latestSeed.current, length), playing: true }),
        ref: (value: BloubBotRef) => { player = value },
        // The current pose (idle, egg, play…), so tests and reviews can see that a bot's avatars agree.
        onStateChange: (pose: string) => { node.dataset.pose = pose },
        get color() { return state().color },
        get shape() { return state().shape },
        get cycle() { return cycleFor(bloub, state().mood, brisk) },
      }), node)
      // bloub stops its clock while an avatar is hidden (folded list, closed panel,
      // background tab), so on its return it would lag the others; seek it back to
      // the shared clock so every avatar of a bot keeps one pose.
      const resync = () => {
        if (frozen || !player) return
        const blocks = cycleFor(bloub, state().mood, brisk)
        const total = blocks.reduce((sum, block) => sum + block.duration, 0)
        const { index, offset } = blockAt(blocks, phaseFor(latestSeed.current, total))
        player.seek(index, offset)
      }
      live.current = { set: next => setState(() => next), resync, dispose }
    }
    if (runtime) mount(runtime)
    else void loadRuntime().then(mount)
    // Ink flips to cream when the theme changes.
    const watch = new MutationObserver(() => live.current?.set(latest.current()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    // When any avatar comes back into view, every avatar on the page seeks to the
    // shared clock at the same moment, so small drift between them is cleared too.
    const align = () => live.current?.resync()
    window.addEventListener(RESYNC_EVENT, align)
    const shown = new IntersectionObserver(entries => { if (entries.at(-1)?.isIntersecting) window.dispatchEvent(new Event(RESYNC_EVENT)) })
    shown.observe(node)
    const returned = () => { if (document.visibilityState === 'visible') window.dispatchEvent(new Event(RESYNC_EVENT)) }
    document.addEventListener('visibilitychange', returned)
    return () => { alive = false; watch.disconnect(); shown.disconnect(); window.removeEventListener(RESYNC_EVENT, align); document.removeEventListener('visibilitychange', returned); live.current?.dispose(); live.current = null; node.replaceChildren() }
  }, [px, still, label, brisk])

  useEffect(() => { live.current?.set(latest.current()) }, [tone, form, mood])

  return <span ref={host} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-slot="bot-avatar" data-color={tone} data-shape={form}
    className={cn('relative inline-flex shrink-0 [&>svg]:absolute [&>svg]:top-1/2 [&>svg]:left-1/2 [&>svg]:max-w-none [&>svg]:-translate-1/2',
      // Buttons and sidebar rows size every svg inside them; the blob's svg keeps its own size (1.58× the box).
      size === 'row' && 'size-4 [&>svg]:size-6.5!', size === 'pill' && 'size-5.5 [&>svg]:size-9!', size === 'search' && 'size-7 [&>svg]:size-11!', size === 'list' && 'size-8.5 [&>svg]:size-13.5!',
      size === 'cell' && 'size-10 [&>svg]:size-16!', size === 'profile' && 'size-18 [&>svg]:size-28.5!', size === 'hero' && 'size-36 [&>svg]:size-57!')} />
}
