'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MousePointer2, Power } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useComputer, useViewerGrant } from '@/hooks/use-computer'
import { withBasePath } from '@/lib/base-path'
import { computerApi } from '@/lib/computer/client'
import { MOCK_SCREEN_URL } from '@/lib/computer/mock'
import { SCREEN_HEIGHT, SCREEN_WIDTH, type ScreenRect, type ViewerMode } from '@/lib/computer/types'
import { cn } from '@/lib/utils'

type RFBInstance = { viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean; background: string; disconnect: () => void; focus: () => void }

/** The noVNC canvas. The URL already carries the short-lived token for this mode. */
function NoVncView({ url, mode, label }: { url: string; mode: ViewerMode; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFBInstance | null>(null)
  useEffect(() => {
    let alive = true
    void import('@novnc/novnc/lib/rfb.js').then(({ default: RFB }) => {
      if (!alive || !host.current) return
      const client = new RFB(host.current, url, { shared: true }) as RFBInstance
      client.scaleViewport = true
      client.resizeSession = false
      client.background = 'transparent'
      client.viewOnly = mode === 'view'
      rfb.current = client
    })
    return () => { alive = false; rfb.current?.disconnect(); rfb.current = null }
  }, [url, mode])
  return <div ref={host} role="img" aria-label={label} className="absolute inset-0" />
}

/** Places an overlay on the 1280×800 desktop; positions are percentages so every size lines up. */
function useScreenBox(rect: ScreenRect | null, pad = 0) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !rect) return
    node.style.setProperty('--box-x', `${((rect.x - pad) / SCREEN_WIDTH) * 100}%`)
    node.style.setProperty('--box-y', `${((rect.y - pad) / SCREEN_HEIGHT) * 100}%`)
    node.style.setProperty('--box-w', `${((rect.w + pad * 2) / SCREEN_WIDTH) * 100}%`)
    node.style.setProperty('--box-h', `${((rect.h + pad * 2) / SCREEN_HEIGHT) * 100}%`)
  }, [rect, pad])
  return ref
}

/** The ring around what the agent is about to touch: blue while it works, orange while it waits for you. */
function TargetRing({ rect, tone }: { rect: ScreenRect; tone: 'agent' | 'approval' }) {
  const ref = useScreenBox(rect, 3)
  return <span ref={ref} aria-hidden="true" className={cn('pointer-events-none absolute top-(--box-y) left-(--box-x) h-(--box-h) w-(--box-w) rounded-md ring-2 transition-[top,left,width,height] duration-150 ease-out motion-reduce:transition-none',
    tone === 'agent' ? 'ring-sidebar-primary' : 'ring-attention')} />
}

function Cursor({ x, y }: { x: number; y: number }) {
  const ref = useScreenBox({ x, y, w: 0, h: 0 })
  return <span ref={ref} aria-hidden="true" className="pointer-events-none absolute top-(--box-y) left-(--box-x) text-foreground transition-[top,left,width,height] duration-150 ease-out motion-reduce:transition-none">
    <MousePointer2 className="size-[max(0.75rem,2cqw)] fill-screen stroke-screen-foreground" />
  </span>
}

/**
 * A bot's live screen at any size (Figma 103:64, 115:1265, 107:416): the VNC
 * picture, the agent's target ring and cursor, and the sleeping and waking
 * covers. `children` sit centered on top (the details page's 打开).
 */
export function ComputerScreen({ botId, name, mode = 'view', live = true, showTarget = true, frame = 'rounded', children }: {
  botId: string
  name: string
  mode?: ViewerMode
  /** False keeps the last picture still (a finished task). */
  live?: boolean
  showTarget?: boolean
  frame?: 'rounded' | 'viewer'
  children?: ReactNode
}) {
  const t = useTranslations('Computer')
  const { data: state, error, mutate } = useComputer(botId)
  const wakeInFlight = useRef(false)
  const [wakePending, setWakePending] = useState(false)
  const waking = wakePending || state?.machine === 'waking'
  const running = state?.machine === 'running'
  const { data: grant, error: grantError, mutate: renewGrant } = useViewerGrant(botId, mode, running && live)
  const approval = state?.pendingApproval
  const target = approval?.action.rect ?? (state?.control === 'agent' ? state.lastAction?.rect : undefined)
  const point = approval ? { x: approval.action.x, y: approval.action.y } : state?.control === 'agent' ? { x: state.lastAction?.x, y: state.lastAction?.y } : null
  async function wake() {
    if (wakeInFlight.current) return
    wakeInFlight.current = true
    setWakePending(true)
    try { await computerApi.wake(botId); await mutate() } catch { toast.error(t('wakeFailed')) }
    finally { wakeInFlight.current = false; setWakePending(false) }
  }
  const label = t('screenOf', { name })
  return <div className={cn('@container/screen relative aspect-[16/10] w-full overflow-hidden bg-screen text-screen-foreground', frame === 'rounded' ? 'rounded-lg' : 'rounded-xl')}>
    {running && grant && (grant.url === MOCK_SCREEN_URL
      ? <img src={withBasePath('/computer/mock-desktop.svg')} alt={label} draggable={false} className="absolute inset-0 size-full select-none" />
      : <NoVncView url={grant.url} mode={mode} label={label} />)}
    {running && live && showTarget && target && <TargetRing rect={target} tone={approval ? 'approval' : 'agent'} />}
    {running && live && showTarget && point?.x !== undefined && point.y !== undefined && <Cursor x={point.x} y={point.y} />}
    {state && !running && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-screen/80 backdrop-blur-sm">
      {/* The caption under the screen names the state; asleep the cover only offers 唤醒 (Figma 188:3115). */}
      {state.machine === 'sleeping' && !waking && <Button size="sm" className="h-9 rounded-full bg-screen-foreground/15 px-3.5 text-screen-foreground hover:bg-screen-foreground/25" onClick={() => { void wake() }}><Power data-icon="inline-start" />{t('wake')}</Button>}
      {waking && <Progress aria-label={t('waking')} value={null} className="w-1/3 max-w-40" />}
      {state.machine === 'error' && !waking && <>
        <p className="text-sm">{t('machineError')}</p>
        <Button size="sm" variant="secondary" className="rounded-lg" onClick={() => { void wake() }}><Power data-icon="inline-start" />{t('retry')}</Button>
      </>}
    </div>}
    {/* Never a blank screen: the state or the picture is still on its way, or its read failed. */}
    {(!state || (running && live && !grant)) && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
      {(state ? grantError : error)
        ? <Button size="sm" variant="secondary" className="rounded-lg" onClick={() => { void (state ? renewGrant() : mutate()) }}><Power data-icon="inline-start" />{t('retry')}</Button>
        : <Progress aria-label={t('loading')} value={null} className="w-1/3 max-w-40" />}
    </div>}
    {running && children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
  </div>
}
