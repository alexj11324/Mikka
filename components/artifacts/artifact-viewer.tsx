'use client'

import { useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronDown, Download, Globe, History, MessageSquare, SquareDashedMousePointer, X } from 'lucide-react'
import { getArtifact, getArtifactText } from '@/app/actions/artifacts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ArtifactQuote } from '@/lib/artifacts/quote'
import type { ArtifactDetail } from '@/lib/artifacts/types'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import { ArtifactAuthorAvatar, ArtifactKindIcon } from './artifact-card'
import { ArtifactDocument } from './artifact-document'
import { ArtifactFrame } from './artifact-frame'
import { ArtifactShare } from './artifact-share'

/** What the reader hands the chat beside it. */
export interface ArtifactChatSlot {
  quote: ArtifactQuote | null
  clearQuote: () => void
  activeArtifactId: string
  openArtifact: (id: string) => void
}

const versionPath = (id: string, version: number, file: 'frame' | 'download') => withBasePath(`/api/artifacts/${id}/versions/${version}/${file}`)

/**
 * The artifact reader (Figma 178:11626): a centred window with the artifact
 * on the left and the same chat on the right, always there, so the person
 * reads and answers in one place. Versions open from the pill by the title;
 * an older version shows its changes against the newest.
 */
export function ArtifactViewer({ artifactId, onArtifactChange, onClose, bot, quotes, chat }: {
  artifactId: string
  onArtifactChange: (id: string) => void
  onClose: () => void
  /** The bot whose chat sits on the right. */
  bot: { name: string; avatar: ReactNode }
  /** Every quote sent from artifacts in this chat; this reader underlines its own. */
  quotes: readonly ArtifactQuote[]
  chat: (slot: ArtifactChatSlot) => ReactNode
}) {
  const t = useTranslations('Artifact')
  const format = useFormatter()
  const { data: detail, error, mutate } = useSWR<ArtifactDetail | null>(['artifact', artifactId], () => getArtifact(artifactId), { revalidateOnFocus: false, refreshInterval: 15000 })
  const [picked, setPicked] = useState<{ id: string; version: number } | null>(null)
  const [showDiff, setShowDiff] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [quote, setQuote] = useState<ArtifactQuote | null>(null)
  const [pane, setPane] = useState<'content' | 'chat'>('content')

  const latest = detail?.latestVersion ?? 1
  const version = picked?.id === artifactId ? picked.version : latest
  const old = version < latest
  const info = detail?.versions.find(item => item.version === version)
  const when = (iso: string) => format.dateTime(new Date(iso), { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const markdown = detail?.kind === 'markdown'
  const { data: text, error: textError } = useSWR(markdown ? ['artifact-text', artifactId, version] : null, () => getArtifactText(artifactId, version), { revalidateOnFocus: false })
  const { data: latestText } = useSWR(markdown && old && showDiff ? ['artifact-text', artifactId, latest] : null, () => getArtifactText(artifactId, latest), { revalidateOnFocus: false })
  const mine = useMemo(() => quotes.filter(item => item.artifactId === artifactId && item.version === version), [quotes, artifactId, version])

  function switchArtifact(id: string) {
    if (id === artifactId) return
    setSelecting(false)
    setPane('content')
    onArtifactChange(id)
  }
  function pickVersion(next: number) {
    setPicked({ id: artifactId, version: next })
    setSelecting(false)
  }
  function quoteText(words: string) {
    setQuote({ artifactId, version, kind: 'text', text: words })
    setPane('chat')
  }

  const failed = error || textError || detail === null
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      className="flex h-[min(53.75rem,calc(100dvh-2rem))] w-[min(80rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl ring-0 sm:max-w-none">
      <header className="flex h-13 shrink-0 items-center gap-2 px-4">
        {detail && <ArtifactKindIcon kind={detail.kind} className="size-4 shrink-0 text-muted-foreground" />}
        <DialogTitle className="truncate text-sm leading-5 font-medium">{detail?.title ?? ''}</DialogTitle>
        {detail && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" size="xs" className="gap-0.5 rounded-md px-1.5 font-normal text-muted-foreground" aria-label={t('versions')} />}>
            {t('version', { version })}<ChevronDown data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 p-1">
            <DropdownMenuRadioGroup value={version} onValueChange={value => pickVersion(Number(value))}>
              {[...detail.versions].reverse().map(item => <DropdownMenuRadioItem key={item.version} value={item.version} closeOnClick className="items-start gap-2.5 rounded-md py-2 pl-2">
                <ArtifactAuthorAvatar author={item} size="pill" />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 text-sm font-medium">{t('version', { version: item.version })}{item.version === latest && <Badge variant="secondary" className="h-4 rounded-sm px-1">{t('current')}</Badge>}</span>
                  <span className="truncate text-xs text-muted-foreground">{t('versionMeta', { author: item.authorName, time: when(item.createdAt) })}</span>
                </span>
              </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>}
        <span className="flex-1" />
        {detail && <ArtifactShare artifactId={artifactId} shared={Boolean(detail.shared)} onChange={() => { void mutate() }} />}
        {detail?.kind === 'markdown' && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" nativeButton={false} aria-label={t('download')} render={<a href={versionPath(artifactId, version, 'download')} download />} />}><Download data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('download')}</TooltipContent></Tooltip>}
        {detail?.kind === 'html' && <>
          <Button variant="ghost" size="sm" aria-pressed={selecting} onClick={() => setSelecting(on => !on)} className={cn('hidden md:inline-flex', selecting && 'bg-sidebar-primary-soft text-sidebar-primary-soft-foreground hover:bg-sidebar-primary-soft hover:text-sidebar-primary-soft-foreground')}><SquareDashedMousePointer data-icon="inline-start" />{t('selectElement')}</Button>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" nativeButton={false} aria-label={t('openInBrowser')} render={<a href={versionPath(artifactId, version, 'frame')} target="_blank" rel="noopener noreferrer" />} />}><Globe data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('openInBrowser')}</TooltipContent></Tooltip>
        </>}
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-pressed={pane === 'chat'} aria-label={pane === 'chat' ? t('showContent') : t('showChat')} onClick={() => setPane(current => current === 'chat' ? 'content' : 'chat')}><MessageSquare data-icon="inline-start" /></Button>
        <Separator orientation="vertical" className="mx-1 data-vertical:h-5 data-vertical:self-center" />
        <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className={cn('flex min-w-0 flex-1 flex-col bg-background', pane === 'chat' && 'hidden md:flex')}>
          {old && info && <div role="status" className="mx-3 mt-1 flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-muted px-3 py-1.5 text-sm">
            <History aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="shrink-0">{t('viewingOld', { version, time: when(info.createdAt) })}</span>
            <span className="flex-1" />
            {markdown && <Label className="shrink-0 font-normal text-muted-foreground"><Switch checked={showDiff} onCheckedChange={setShowDiff} />{t('showDiff', { latest })}</Label>}
            {markdown && <Separator orientation="vertical" className="data-vertical:h-5 data-vertical:self-center" />}
            <Button variant="secondary" size="sm" className="bg-background hover:bg-background/80" onClick={() => pickVersion(latest)}>{t('backToLatest', { latest })}</Button>
          </div>}
          {failed
            ? <Empty className="flex-1"><EmptyHeader><EmptyTitle>{t('loadError')}</EmptyTitle></EmptyHeader><Button variant="outline" onClick={() => void mutate()}>{t('retry')}</Button></Empty>
            : !detail || (markdown && text === undefined) ? <div className="flex flex-1 items-center justify-center"><Spinner /></div>
            : markdown ? <ArtifactDocument key={`${artifactId}:${version}`} title={detail.title} markdown={text ?? ''} compareWith={old && showDiff ? latestText ?? null : null}
                author={info ?? { authorName: '', authorColor: null, authorShape: null }} meta={info ? t(old ? 'versionMeta' : 'updated', { author: info.authorName, time: when(info.createdAt) }) : ''}
                quoted={mine.filter(item => item.kind === 'text').map(item => item.text)} quoting={quote?.kind === 'text' && quote.artifactId === artifactId && quote.version === version ? quote.text : null}
                onQuote={quoteText} />
            : <ArtifactFrame src={versionPath(artifactId, version, 'frame')} title={t('frameTitle', { title: detail.title })} selecting={selecting}
                marked={[...mine.flatMap(item => item.selector ? [item.selector] : []), ...(quote?.selector && quote.artifactId === artifactId && quote.version === version ? [quote.selector] : [])]}
                onSelectOff={() => setSelecting(false)}
                onQuote={element => { setQuote({ artifactId, version, kind: 'element', text: element.text || element.label, label: element.label, selector: element.selector }); setSelecting(false); setPane('chat') }} />}
        </main>
        <aside aria-label={bot.name} className={cn('w-full flex-col bg-muted/50 md:flex md:w-[25rem] md:shrink-0', pane === 'chat' ? 'flex' : 'hidden')}>
          <div className="flex h-12 shrink-0 items-center gap-2 px-4">
            {bot.avatar}
            <span className="truncate text-sm font-medium">{bot.name}</span>
          </div>
          {chat({ quote, clearQuote: () => setQuote(null), activeArtifactId: artifactId, openArtifact: switchArtifact })}
        </aside>
      </div>
    </DialogContent>
  </Dialog>
}
