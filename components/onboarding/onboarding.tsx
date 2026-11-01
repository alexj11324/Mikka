'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { CheckIcon } from 'lucide-react'
import { createBot, listBots, type BotView } from '@/app/actions/bots'
import { completeOnboarding } from '@/app/actions/onboarding'
import { BOT_MOOD_SECONDS, BotAvatar, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotMood, type BotShape } from '@/components/nav/bot-avatar'
import { BotLookPicker } from '@/components/nav/bot-look-picker'
import { AppTile, useConnectedApps } from '@/components/plugins/connected-apps'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { COMPOSIO_APP_IDS, type ComposioAppId } from '@/lib/composio-accounts'
import { EASE_OUT } from '@/lib/ease'
import { useActionError } from '@/lib/use-action-error'

/**
 * Whether the guide asks about the cloud computer (docs/design/onboarding.md,
 * step 2). `ask`: the person can add the workspace's E2B key here. `member`:
 * only an admin can, so the Bot says so and moves on. `none`: the computer
 * needs nothing from them.
 */
export type OnboardingComputer = 'ask' | 'none'

/** What saving an E2B key came to; the key itself never comes back. */
export type E2BKeyResult = 'ok' | 'invalid' | 'unavailable'

type Line = { id: number; from: 'bot' | 'person'; text: string }
type Stage = 'intro' | 'chat' | 'welcome'
type Card = 'intro' | 'name' | 'computer' | 'key' | 'apps' | 'welcome' | null

/** The guide's pacing, in ms (docs/design/onboarding.md §5). */
const PACE = { dim: 3000, autoStart: 8000, travel: 640, firstLine: 400, botGap: 2500, replyBeat: 1000, lastBeat: 1200, rise: 700 }
const IDLE_MOVES: BotMood[] = ['wink', 'wide', 'play', 'hexagon']
const BUBBLE_SPRING = { type: 'spring', stiffness: 520, damping: 27, mass: 0.52 } as const

/**
 * The first-run guide: one conversation with the person's first Bot. It names
 * the Bot and picks its look, asks about the cloud computer, connects apps,
 * then shows the Bot on a welcome page. Leaving for an app's sign-in reloads
 * the page; the guide picks up after the name, because the Bot already exists.
 */
export function Onboarding({ computer = 'none', saveKey, onDone }: { computer?: OnboardingComputer; saveKey?: (apiKey: string) => Promise<E2BKeyResult>; onDone: (bot: BotView | null) => void }) {
  const t = useTranslations('Onboarding')
  const tApps = useTranslations('Settings.integrations')
  const locale = useLocale()
  const actionError = useActionError()
  const reduce = useReducedMotion() ?? false
  const { mutate } = useSWRConfig()
  const { data: bots } = useSWR('bots', listBots)
  const apps = useConnectedApps()
  const appsRef = useRef(apps)
  appsRef.current = apps

  const [stage, setStage] = useState<Stage>('intro')
  const [card, setCard] = useState<Card>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [mood, setMood] = useState<BotMood>('idle')
  const [bot, setBot] = useState<BotView | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<BotColor>(DEFAULT_BOT_COLOR)
  const [shape, setShape] = useState<BotShape>(DEFAULT_BOT_SHAPE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [body, animateBody] = useAnimate<HTMLDivElement>()
  const thread = useRef<HTMLDivElement>(null)
  // A new line, or a card taking room, keeps the latest line in view.
  useEffect(() => {
    const node = thread.current
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }, [lines, card, reduce])

  // Every wait ends when the guide closes, so a script never runs on after it.
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const wait = useCallback((ms: number) => new Promise<void>((resolve, reject) => {
    setTimeout(() => alive.current ? resolve() : reject(new Error('closed')), reduce ? Math.min(ms, 150) : ms)
  }), [reduce])

  const lineId = useRef(0)
  const push = (from: Line['from'], text: string) => setLines(current => [...current, { id: ++lineId.current, from, text }])
  const lastFrom = useRef<Line['from'] | null>(null)
  async function say(text: string) {
    await wait(lastFrom.current === 'bot' ? PACE.botGap : lastFrom.current === 'person' ? PACE.replyBeat : PACE.firstLine)
    lastFrom.current = 'bot'
    push('bot', text)
    await wait(PACE.rise)
  }
  function reply(text: string) {
    lastFrom.current = 'person'
    push('person', text)
  }

  // A move plays once at bloub's pace, then the Bot holds idle afresh so its shape comes back.
  const moodTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const act = useCallback((next: BotMood, hold = false) => {
    // With reduced motion the Bot only shows state (thinking, an error), never a move.
    if (reduce && next !== 'thinking' && next !== 'exclaim' && next !== 'idle') return
    clearTimeout(moodTimer.current)
    setMood(next)
    if (!hold && next !== 'idle') moodTimer.current = setTimeout(() => setMood('idle'), BOT_MOOD_SECONDS[next] * 1000)
  }, [reduce])
  useEffect(() => () => clearTimeout(moodTimer.current), [])
  const hop = useCallback((height = 10) => {
    if (reduce || !body.current) return
    void animateBody(body.current, { y: [0, -height, 0], scaleY: [1, 1.06, 0.94, 1], scaleX: [1, 0.96, 1.05, 1] }, { duration: 0.55, ease: EASE_OUT })
  }, [animateBody, body, reduce])

  // Now and then the Bot does something small on its own.
  useEffect(() => {
    if (reduce || mood !== 'idle' || stage === 'intro' && card === null) return
    const timer = setTimeout(() => {
      const move = IDLE_MOVES[Math.floor(Math.random() * IDLE_MOVES.length)]
      act(move)
      if (Math.random() < 0.4) hop(6)
    }, 6000 + Math.random() * 5000)
    return () => clearTimeout(timer)
  }, [mood, stage, card, reduce, act, hop])

  // Opening: the Bot appears; a returning person (back from an app's sign-in) skips to after the name.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || bots === undefined) return
    opened.current = true
    // listBots is the person's own Bots in this workspace, oldest first, with their Coordinator marked:
    // a replay uses the first one they made and creates none (onboarding.md §3).
    const existing = bots.find(bot => !bot.coordinator)
    if (existing) {
      setBot(existing); setColor(existing.color as BotColor); setShape(existing.shape as BotShape); setStage('chat')
      void run(() => afterName(existing))
      return
    }
    void run(async () => {
      await wait(PACE.firstLine)
      act('burst')
      hop()
      await wait(PACE.rise)
      setCard('intro')
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the bot list first loads
  }, [bots])

  // The intro starts by itself after a while.
  useEffect(() => {
    if (card !== 'intro') return
    const timer = setTimeout(() => { void begin() }, reduce ? PACE.autoStart * 2 : PACE.autoStart)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- begin reads the latest state
  }, [card])

  async function run(script: () => Promise<void>) {
    try { await script() } catch { /* the guide closed mid-line */ }
  }

  function begin() {
    if (card !== 'intro') return
    setCard(null)
    setStage('chat')
    return run(async () => {
      await wait(PACE.travel)
      act('orbit')
      await say(t('hello'))
      setCard('name')
    })
  }

  async function saveName() {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true); setError('')
    try {
      const created = await createBot({ name: trimmed, color, shape })
      void mutate('bots')
      setBot(created)
      setCard(null)
      reply(t('nameReply', { name: created.name }))
      void run(async () => {
        await wait(PACE.replyBeat)
        act('wink'); hop()
        await say(t('named', { name: created.name }))
        await afterName(created)
      })
    } catch (failure) {
      act('exclaim'); hop(4)
      setError(actionError(failure instanceof Error ? failure.message : null))
    } finally {
      setBusy(false)
    }
  }

  async function afterName(current: BotView) {
    if (computer === 'ask' && saveKey) {
      await say(t('computerAsk'))
      setCard('computer')
      return
    }
    await askApps(current)
  }

  function skipComputer() {
    setCard(null)
    reply(t('computerNo'))
    void run(async () => {
      await say(t('computerLater'))
      await askApps(bot)
    })
  }

  async function submitKey() {
    const key = apiKey.trim()
    if (!key || busy || !saveKey) return
    setBusy(true); setError('')
    act('thinking', true)
    try {
      const result = await saveKey(key).catch((): E2BKeyResult => 'unavailable')
      if (result !== 'ok') {
        act('exclaim'); hop(4)
        setError(t(result === 'invalid' ? 'keyInvalid' : 'keyUnavailable'))
        return
      }
      setApiKey('')
      setCard(null)
      reply(t('keyReply'))
      void run(async () => {
        await wait(PACE.replyBeat)
        act('comet'); hop()
        await say(t('computerReady'))
        await askApps(bot)
      })
    } finally {
      setBusy(false)
      setMood(current => current === 'thinking' ? 'idle' : current)
    }
  }

  async function askApps(current: BotView | null) {
    // Wait for the list of apps, so the Bot does not ask about apps this deployment cannot connect.
    for (let tries = 0; !appsRef.current.state && !appsRef.current.error && tries < 50; tries++) await wait(100)
    if (!appsRef.current.canLink) { await finish(current); return }
    await say(t('appsAsk'))
    setCard('apps')
  }

  const connected = COMPOSIO_APP_IDS.filter(app => apps.accountsFor(app).length > 0)
  function doneApps() {
    setCard(null)
    const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(connected.map(app => tApps(app)))
    reply(connected.length ? t('appsReplyDone') : t('appsNo'))
    void run(async () => {
      if (connected.length) { act('wink'); hop() }
      await say(connected.length ? t('appsDone', { apps: names }) : t('appsLater'))
      await finish(bot)
    })
  }

  async function finish(current: BotView | null) {
    await wait(PACE.lastBeat)
    setStage('welcome')
    await wait(PACE.travel)
    act('orbit'); hop(14)
    await wait(PACE.rise)
    if (current) setBot(current)
    setCard('welcome')
  }

  const closing = useRef(false)
  async function close() {
    if (closing.current) return
    closing.current = true
    setBusy(true)
    try { await completeOnboarding() } catch { /* the guide still closes; it shows again next time */ }
    onDone(bot)
  }

  // The Bot is 144px on the intro and welcome pages and 96px in the conversation.
  const avatarPx = stage === 'chat' ? 96 : 144
  const travel = { duration: reduce ? 0 : PACE.travel / 1000, ease: EASE_OUT }
  return <div role="dialog" aria-modal="true" aria-label={t('title')} className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background">
    {/* The light deepens a step at a time as the guide goes on. */}
    <motion.div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-radial from-muted via-background to-background"
      initial={{ opacity: 0 }} animate={{ opacity: stage === 'intro' ? 0.5 : stage === 'chat' ? 0.75 : 1 }} transition={{ duration: reduce ? 0 : PACE.dim / 1000, ease: EASE_OUT }} />
    <div className="relative flex justify-end p-4">
      {card !== 'welcome' && <Button variant="ghost" size="sm" disabled={busy && closing.current} onClick={() => { void close() }}>{t('skip')}</Button>}
    </div>
    {/* The Bot, the conversation and the current card sit together in the middle; a long conversation pushes the Bot up and then scrolls.
        One 600px column: the Bot's lines start at its left edge and the person's bubbles end at its right edge (R-39). */}
    <div className="relative mx-auto flex min-h-0 w-full max-w-[632px] flex-1 flex-col justify-center gap-8 px-4 pb-16">
      <motion.div layout={reduce ? false : 'position'} transition={travel} className="flex shrink-0 flex-col items-center gap-2">
        <motion.div className="flex items-center justify-center" initial={false} animate={{ height: avatarPx }} transition={travel}>
          <motion.div initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: avatarPx / 144 }} transition={travel}>
            <div ref={body}><BotAvatar color={color} shape={shape} size="hero" mood={mood} brisk label={bot?.name ?? t('botLabel')} /></div>
          </motion.div>
        </motion.div>
        <AnimatePresence>
          {stage === 'chat' && bot && <motion.p key="name" className="text-sm font-medium" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.25 }}>{bot.name}</motion.p>}
        </AnimatePresence>
      </motion.div>

      {stage !== 'welcome' && lines.length > 0 && <div ref={thread} aria-live="polite" className="flex min-h-0 w-full flex-col gap-4 overflow-y-auto">
        <AnimatePresence initial={false}>
          {lines.map(line => line.from === 'bot'
            ? <motion.p key={line.id} className="text-base" initial={{ opacity: 0, y: reduce ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduce ? 0 : PACE.rise / 1000, ease: EASE_OUT }}>{line.text}</motion.p>
            : <motion.div key={line.id} className="flex justify-end" initial={{ opacity: 0, y: reduce ? 0 : 40, scale: reduce ? 1 : 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={reduce ? { duration: 0 } : BUBBLE_SPRING}>
              <Bubble variant="secondary" align="end" className="max-w-[80%] *:data-[slot=bubble-content]:bg-sidebar-primary *:data-[slot=bubble-content]:text-sidebar-primary-foreground"><BubbleContent className="rounded-2xl px-4 py-3">{line.text}</BubbleContent></Bubble>
            </motion.div>)}
        </AnimatePresence>
      </div>}

      <AnimatePresence mode="wait">
        {card && <motion.div key={card} layout={reduce ? false : 'position'} className="shrink-0" initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.15 } }} transition={{ duration: reduce ? 0 : 0.25, ease: EASE_OUT }}>
          {card === 'intro' && <div className="flex flex-col items-center gap-6">
            <h1 className="text-xl font-semibold">{t('title')}</h1>
            <Button size="lg" autoFocus onClick={() => { void begin() }}>{t('start')}</Button>
          </div>}

          {card === 'name' && <form className="flex flex-col gap-4 rounded-xl bg-muted p-4" onSubmit={event => { event.preventDefault(); void saveName() }}>
            <FieldGroup className="gap-4">
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="onboarding-name" className="sr-only">{t('nameLabel')}</FieldLabel>
                <Input id="onboarding-name" autoFocus value={name} maxLength={60} disabled={busy} placeholder={t('nameLabel')} aria-invalid={error ? true : undefined}
                  className="h-11 rounded-lg border-transparent bg-background focus-visible:border-transparent focus-visible:ring-0" onChange={event => { setName(event.target.value); setError('') }} />
                {error && <FieldError>{error}</FieldError>}
              </Field>
              <BotLookPicker color={color} shape={shape} disabled={busy} onColor={next => { setColor(next); hop(4) }} onShape={next => { setShape(next); hop(4) }} />
            </FieldGroup>
            <div className="flex justify-end">
              <Button type="submit" disabled={!name.trim() || busy}>{busy && <Spinner data-icon="inline-start" />}{t('confirm')}</Button>
            </div>
          </form>}

          {card === 'computer' && <div className="flex gap-2">
            <Button onClick={() => { setCard('key'); reply(t('computerYes')) }}>{t('computerYes')}</Button>
            <Button variant="outline" onClick={skipComputer}>{t('computerNo')}</Button>
          </div>}

          {card === 'key' && <form className="flex flex-col gap-4 rounded-xl bg-muted p-4" onSubmit={event => { event.preventDefault(); void submitKey() }}>
            <FieldGroup>
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="onboarding-e2b-key">{t('keyLabel')}</FieldLabel>
                <Input id="onboarding-e2b-key" type="password" autoComplete="off" spellCheck={false} autoFocus value={apiKey} disabled={busy} aria-invalid={error ? true : undefined}
                  className="h-11 rounded-lg border-transparent bg-background focus-visible:border-transparent focus-visible:ring-0" onChange={event => { setApiKey(event.target.value); setError('') }} />
                {error && <FieldError>{error}</FieldError>}
              </Field>
            </FieldGroup>
            <div className="flex items-center justify-between gap-2">
              <Button variant="link" className="px-0" nativeButton={false} role="link" render={<a href="https://e2b.dev/dashboard" target="_blank" rel="noopener noreferrer" />}>{t('keyLink')}</Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={() => { setError(''); act('idle'); skipComputer() }}>{t('computerNo')}</Button>
                <Button type="submit" disabled={!apiKey.trim() || busy}>{busy && <Spinner data-icon="inline-start" />}{t('keyConnect')}</Button>
              </div>
            </div>
          </form>}

          {card === 'apps' && <div className="flex flex-col gap-4 rounded-xl bg-muted p-4">
            <div role="list" className="flex flex-col gap-1">
              {!apps.state
                ? COMPOSIO_APP_IDS.map(app => <Skeleton key={app} className="h-14 w-full rounded-lg" />)
                : COMPOSIO_APP_IDS.map(app => <AppRow key={app} app={app} connected={connected.includes(app)} pending={apps.pending === app} disabled={Boolean(apps.pending)} onConnect={() => { void apps.connect(app) }} />)}
            </div>
            {(apps.error || apps.notice?.tone === 'alert') && <FieldError>{apps.error || apps.notice?.text}</FieldError>}
            <div className="flex justify-end gap-2">
              {connected.length > 0
                ? <Button onClick={doneApps}>{t('appsContinue')}</Button>
                : <Button variant="outline" onClick={doneApps}>{t('appsNo')}</Button>}
            </div>
          </div>}

          {card === 'welcome' && <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold">{bot?.name ?? t('title')}</h1>
              {bot && <p className="text-sm text-muted-foreground">{t('welcome')}</p>}
            </div>
            <Button size="lg" autoFocus disabled={busy} onClick={() => { void close() }}>{busy && <Spinner data-icon="inline-start" />}{t('enter')}</Button>
          </div>}
        </motion.div>}
      </AnimatePresence>
    </div>
  </div>
}

function AppRow({ app, connected, pending, disabled, onConnect }: { app: ComposioAppId; connected: boolean; pending: boolean; disabled: boolean; onConnect: () => void }) {
  const t = useTranslations('Onboarding')
  const tApps = useTranslations('Settings.integrations')
  return <Item role="listitem" size="sm" className="rounded-lg px-2">
    <ItemMedia><AppTile app={app} /></ItemMedia>
    <ItemContent>
      <ItemTitle>{tApps(app)}</ItemTitle>
      <ItemDescription>{t(`apps.${app}`)}</ItemDescription>
    </ItemContent>
    <ItemActions>
      {connected
        ? <span className="flex items-center gap-1 text-sm text-muted-foreground"><CheckIcon aria-hidden="true" className="size-4" />{t('connected')}</span>
        : <Button size="sm" variant="outline" disabled={disabled} onClick={onConnect}>{pending && <Spinner data-icon="inline-start" />}{t('connect')}</Button>}
    </ItemActions>
  </Item>
}
