'use client'

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowLeft, ArrowRight, ArrowUp, ExternalLink, RotateCw, SquareDashed, SquareDashedMousePointer, X } from 'lucide-react'
import { ELEMENT_ROLES, FRAME_SCRIPT, type ElementRole, type FromFrame, type ToFrame } from '@mikka/protocol/artifact-frame'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NOTE_MAX, normalizeAddress, pageLabel, sameOrigin, type BrowserNote } from '@/lib/browser/note'
import { cn } from '@/lib/utils'
import { useBrowserNotes } from './browser-notes'

const STORAGE_KEY = 'mikka:browser-url'
const PICKER_FLAG = '__mikkaPicker'

type Box = { x: number; y: number; width: number; height: number }
type Draft = Omit<BrowserNote, 'n' | 'note'> & { anchor: Box }
type Mode = 'off' | 'element' | 'region'

const pressed = 'bg-sidebar-primary-soft text-sidebar-primary-soft-foreground hover:bg-sidebar-primary-soft hover:text-sidebar-primary-soft-foreground'

function boxOf(start: { x: number; y: number }, end: { x: number; y: number }): Box {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}

/**
 * The app-wide browser (Figma 412:8066), opened from the top bar's globe: an
 * address bar over the page in a frame. It is the person's own browser, not a
 * bot's computer. A note pinned on the page goes into the chat composer on
 * screen as a chip and is sent with the next message.
 *
 * What it can honestly see: a page on the app's own origin can be reached, so
 * 选择元素 puts the artifact frame's picking script into it and names the
 * element clicked. Any other origin is closed to the app (and many sites refuse
 * to be framed at all), so there only 框选区域 works: the person drags a box
 * over the frame and the note carries the URL and that box, nothing read from
 * the page.
 */
export function BrowserPane({ onClose }: { onClose: () => void }) {
  const t = useTranslations('Browser')
  const tRoles = useTranslations('Artifact.roles')
  const notes = useBrowserNotes()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  // `frame.id` changes on every navigation from here, so going back to the same URL reloads the frame.
  const [frame, setFrame] = useState<{ src: string; id: number } | null>(null)
  const [history, setHistory] = useState<{ entries: string[]; index: number }>({ entries: [], index: -1 })
  const [address, setAddress] = useState('')
  const [invalid, setInvalid] = useState(false)
  // True once the loaded page turned out to be reachable (same origin) and has the picking script.
  const [reachable, setReachable] = useState(false)
  const [mode, setMode] = useState<Mode>('off')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [text, setText] = useState('')
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null)
  const current = history.entries[history.index] ?? null
  const canNote = Boolean(notes?.hasComposer)

  const roles = Object.fromEntries(ELEMENT_ROLES.map(role => [role, tRoles(role)])) as Record<ElementRole, string>
  const state = useRef({ mode, draft, roles, current, notes: notes?.notes ?? [] })
  state.current = { mode, draft, roles, current, notes: notes?.notes ?? [] }

  function load(src: string, push: boolean) {
    setFrame(previous => ({ src, id: (previous?.id ?? 0) + 1 }))
    setReachable(false)
    setDraft(null)
    setMode('off')
    setAddress(src)
    setInvalid(false)
    if (push) setHistory(previous => ({ entries: [...previous.entries.slice(0, previous.index + 1), src], index: previous.index + 1 }))
    try { window.localStorage.setItem(STORAGE_KEY, src) } catch { /* storage unavailable */ }
  }

  // Reopening the browser comes back to the last page.
  useEffect(() => {
    let saved: string | null = null
    try { saved = window.localStorage.getItem(STORAGE_KEY) } catch { /* storage unavailable */ }
    const src = saved ? normalizeAddress(saved, window.location.origin) : null
    if (src) load(src, true)
    else addressRef.current?.focus()
  }, [])

  function go(step: -1 | 1) {
    const index = history.index + step
    const src = history.entries[index]
    if (!src) return
    setHistory(previous => ({ ...previous, index }))
    load(src, false)
  }

  function submitAddress() {
    const src = normalizeAddress(address, window.location.origin)
    if (!src) { setInvalid(true); return }
    load(src, true)
    addressRef.current?.blur()
  }

  const post = (message: ToFrame) => frameRef.current?.contentWindow?.postMessage(message, window.location.origin)
  function sync() {
    const { mode: currentMode, draft: currentDraft, roles: words, current: page } = state.current
    post({ source: 'mikka', type: 'select', on: currentMode === 'element' && !currentDraft, roles: words })
    const marked = state.current.notes.filter(note => note.kind === 'element' && note.url === page && note.selector).map(note => note.selector!)
    if (currentDraft?.selector) marked.push(currentDraft.selector)
    post({ source: 'mikka', type: 'mark', selectors: marked })
  }

  /** The page the frame shows now: for a reachable page its own address, which may differ after a link was followed. */
  function frameAddress(): string | null {
    try {
      const href = frameRef.current?.contentWindow?.location.href
      return href && href !== 'about:blank' ? href : null
    } catch { return null }
  }

  function onFrameLoad() {
    let doc: Document | null = null
    try { doc = frameRef.current?.contentDocument ?? null } catch { doc = null }
    const win = frameRef.current?.contentWindow as (Window & { [PICKER_FLAG]?: true }) | null
    if (!doc || !win || !frame || !sameOrigin(frame.src, window.location.origin)) { setReachable(false); return }
    const href = frameAddress()
    // A link followed inside the page: the address bar and history follow it.
    if (href && href !== state.current.current) {
      setAddress(href)
      setHistory(previous => ({ entries: [...previous.entries.slice(0, previous.index + 1), href], index: previous.index + 1 }))
      try { window.localStorage.setItem(STORAGE_KEY, href) } catch { /* storage unavailable */ }
    }
    if (!win[PICKER_FLAG]) {
      win[PICKER_FLAG] = true
      const script = doc.createElement('script')
      script.textContent = FRAME_SCRIPT
      ;(doc.head ?? doc.documentElement).appendChild(script)
    }
    setReachable(true)
  }

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow || event.origin !== window.location.origin) return
      const data = event.data as FromFrame
      if (!data || data.source !== 'mikka-frame') return
      if (data.type === 'ready') sync()
      if (data.type === 'select-off') setMode('off')
      if (data.type === 'quote' && typeof data.selector === 'string' && typeof data.label === 'string' && state.current.mode === 'element') {
        const selector = data.selector.slice(0, 1000)
        let anchor: Box = { x: 16, y: 16, width: 0, height: 0 }
        try {
          const rect = frameRef.current.contentDocument?.querySelector(selector)?.getBoundingClientRect()
          if (rect) anchor = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        } catch { /* the selector no longer matches */ }
        const url = frameAddress() ?? state.current.current ?? ''
        setText('')
        setDraft({ kind: 'element', url, label: data.label.slice(0, 200), selector, text: String(data.text ?? '').slice(0, 500), anchor })
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(sync, [mode, draft, notes?.notes, reachable])

  // Escape leaves picking; inside a reachable page its own script reports it.
  useEffect(() => {
    if (mode === 'off' || draft) return
    const leave = (event: KeyboardEvent) => { if (event.key === 'Escape') { setDrag(null); setMode('off') } }
    window.addEventListener('keydown', leave)
    return () => window.removeEventListener('keydown', leave)
  }, [mode, draft])

  // Without a chat to send to, or once the page is gone, nothing can be picked.
  useEffect(() => { if (!canNote) { setMode('off'); setDraft(null) } }, [canNote])
  useEffect(() => { if (mode === 'element' && !reachable) setMode('off') }, [mode, reachable])

  function point(event: ReactPointerEvent) {
    const rect = stageRef.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) }
  }
  function endDrag(event: ReactPointerEvent) {
    if (!drag) return
    const box = boxOf(drag.start, point(event))
    setDrag(null)
    if (box.width < 8 || box.height < 8 || !current) return
    const stage = stageRef.current!
    const url = frameAddress() ?? current
    setText('')
    setDraft({ kind: 'region', url, label: pageLabel(url), rect: { ...box, viewportWidth: stage.clientWidth, viewportHeight: stage.clientHeight }, anchor: box })
  }

  function addNote(event?: { preventDefault: () => void }) {
    event?.preventDefault()
    const note = text.trim()
    if (!draft || !note || !notes) return
    const { anchor: _anchor, ...rest } = draft
    notes.add({ ...rest, note: note.slice(0, NOTE_MAX) })
    setDraft(null)
    setText('')
    setMode('off')
  }
  function cancelDraft() { setDraft(null); setText('') }

  // The note card sits under what it is about, or above it when there is no room below.
  const stageSize = { width: stageRef.current?.clientWidth ?? 0, height: stageRef.current?.clientHeight ?? 0 }
  const cardLeft = draft ? Math.max(8, Math.min(draft.anchor.x, stageSize.width - 288)) : 0
  const below = draft ? draft.anchor.y + draft.anchor.height + 8 : 0
  const cardTop = draft ? below + 96 > stageSize.height ? Math.max(8, draft.anchor.y - 104) : below : 0
  const dragBox = drag ? boxOf(drag.start, drag.end) : null
  const regionBox = draft?.kind === 'region' ? draft.anchor : dragBox
  // Positions go in as CSS variables on the stage (as on the computer screen), read by the box and the card.
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const set = (name: string, value: number) => stage.style.setProperty(name, `${Math.round(value)}px`)
    if (regionBox) { set('--region-x', regionBox.x); set('--region-y', regionBox.y); set('--region-w', regionBox.width); set('--region-h', regionBox.height) }
    if (draft) { set('--note-x', cardLeft); set('--note-y', cardTop) }
  })

  const tool = (label: string, icon: ReactNode, props: { onClick?: () => void; disabled?: boolean; pressed?: boolean }) =>
    <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn('text-muted-foreground', props.pressed && pressed)} aria-label={label} aria-pressed={props.pressed} disabled={props.disabled} onClick={props.onClick} />}>{icon}</TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>

  return <aside aria-label={t('label')} data-slot="browser-pane" className="hidden min-h-0 w-140 max-w-[50%] shrink-0 flex-col border-l lg:flex">
    <div className="flex h-11 shrink-0 items-center gap-0.5 px-2">
      {tool(t('back'), <ArrowLeft data-icon="inline-start" />, { onClick: () => go(-1), disabled: history.index <= 0 })}
      {tool(t('forward'), <ArrowRight data-icon="inline-start" />, { onClick: () => go(1), disabled: history.index >= history.entries.length - 1 })}
      {tool(t('reload'), <RotateCw data-icon="inline-start" />, { onClick: () => { if (current) load(current, false) }, disabled: !current })}
      <Input ref={addressRef} type="url" inputMode="url" enterKeyHint="go" aria-label={t('address')} placeholder={t('addressPlaceholder')} value={address} aria-invalid={invalid || undefined} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        onChange={event => { setAddress(event.target.value); setInvalid(false) }} onFocus={event => event.target.select()}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submitAddress() } }}
        className="mx-1 h-8 min-w-0 flex-1 rounded-lg border-0 bg-muted px-2.5 text-sm text-muted-foreground focus-visible:text-foreground" />
      {tool(t('selectElement'), <SquareDashedMousePointer data-icon="inline-start" />, { onClick: () => { setDraft(null); setMode(value => value === 'element' ? 'off' : 'element') }, disabled: !canNote || !reachable, pressed: mode === 'element' })}
      {tool(t('selectRegion'), <SquareDashed data-icon="inline-start" />, { onClick: () => { setDraft(null); setMode(value => value === 'region' ? 'off' : 'region') }, disabled: !canNote || !current, pressed: mode === 'region' })}
      {current
        ? <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" nativeButton={false} aria-label={t('openInTab')} render={<a href={current} target="_blank" rel="noopener noreferrer" />} />}><ExternalLink data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('openInTab')}</TooltipContent></Tooltip>
        : tool(t('openInTab'), <ExternalLink data-icon="inline-start" />, { disabled: true })}
      {tool(t('close'), <X data-icon="inline-start" />, { onClick: onClose })}
    </div>
    <div ref={stageRef} data-slot="browser-stage" className="relative min-h-0 flex-1 overflow-hidden bg-background">
      {frame && (sameOrigin(frame.src, window.location.origin)
        ? <iframe ref={frameRef} key={frame.id} src={frame.src} title={t('frameTitle')} onLoad={onFrameLoad} className="size-full border-0" />
        : <iframe ref={frameRef} key={frame.id} src={frame.src} title={t('frameTitle')} onLoad={onFrameLoad} referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" className="size-full border-0" />)}
      {mode === 'region' && !draft && <div data-slot="browser-region-layer" className="absolute inset-0 cursor-crosshair touch-none"
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); const at = point(event); setDrag({ start: at, end: at }) }}
        onPointerMove={event => { if (drag) setDrag({ ...drag, end: point(event) }) }}
        onPointerUp={endDrag} onPointerCancel={() => setDrag(null)} />}
      {regionBox && <div aria-hidden="true" className="pointer-events-none absolute top-(--region-y) left-(--region-x) h-(--region-h) w-(--region-w) rounded-md border-2 border-dashed border-sidebar-primary" />}
      {draft && <form data-slot="browser-note-draft" onSubmit={addNote} className="absolute top-(--note-y) left-(--note-x) z-10 w-70 rounded-xl bg-popover p-1 text-popover-foreground shadow-md">
        <InputGroup className="rounded-lg border-0 bg-transparent shadow-none">
          <InputGroupTextarea autoFocus aria-label={t('note', { label: draft.label })} placeholder={t('notePlaceholder')} value={text} maxLength={NOTE_MAX} rows={1} className="max-h-32 min-h-9 py-2 text-sm"
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); cancelDraft() }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) addNote(event)
            }} />
          <InputGroupAddon align="inline-end" className="self-end pb-1.5">
            <InputGroupButton type="submit" variant="default" size="icon-xs" className="rounded-full" aria-label={t('addNote')} disabled={!text.trim()}><ArrowUp /></InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>}
    </div>
  </aside>
}
