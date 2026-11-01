'use client'

import { useState, type ComponentType } from 'react'
import useSWR from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { AppWindow, FileText } from 'lucide-react'
import { listArtifacts } from '@/app/actions/artifacts'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import type { ArtifactKind } from '@/lib/db/schema'
import type { ArtifactListItem } from '@/lib/artifacts/types'
import { cn } from '@/lib/utils'
import { ArtifactKindIcon } from './artifact-card'
import { ArtifactWindow } from './artifact-window'
import { InlineLoadError } from '@/components/load-error'

/** The categories on the left: everything, then one per kind an artifact can be today. */
type Category = 'all' | ArtifactKind
const CATEGORIES: { id: Category; icon: ComponentType<{ className?: string; 'data-icon'?: string }>; label: 'all' | 'documents' | 'pages' }[] = [
  { id: 'all', icon: ArtifactIcon, label: 'all' },
  { id: 'markdown', icon: FileText, label: 'documents' },
  { id: 'html', icon: AppWindow, label: 'pages' },
]

// 名称 takes the rest; 来源 and 上次活动 are fixed and right-aligned, so no gap opens between them.
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-4 md:grid-cols-[minmax(0,1fr)_10rem_6rem]'

/**
 * Artifact (rail, Figma F2 `395:27790`): categories on the left; on the right
 * the table 名称 / 状态 / 来源 / 上次活动. A row opens the Artifact window (F4).
 */
export function ArtifactLibrary({ onOpenIssue }: { onOpenIssue: (id: string) => void }) {
  const t = useTranslations('ArtifactsPage')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { data, error, mutate } = useSWR('artifacts', () => listArtifacts())
  const [category, setCategory] = useState<Category>('all')
  const [open, setOpen] = useState<Pick<ArtifactListItem, 'id' | 'runId' | 'issueId' | 'botId'> | null>(null)
  const rows = (data ?? []).filter(item => category === 'all' || item.kind === category)
  const current = CATEGORIES.find(item => item.id === category)!
  const source = (item: ArtifactListItem) => [item.authorName, item.issueKey].filter(Boolean).join(' · ') || '—'

  return <div className="flex min-h-0 flex-1 flex-col md:flex-row">
    <aside aria-labelledby="artifact-library-title" className="flex shrink-0 flex-col gap-1 border-rule px-2 pt-6 pb-3 md:w-68 md:border-r md:pb-6">
      <h1 id="artifact-library-title" className="px-2 pb-3 text-xl leading-7 font-semibold">{t('title')}</h1>
      <ul className="flex gap-1 overflow-x-auto md:flex-col">
        {CATEGORIES.map(item => <li key={item.id}>
          <Button variant="ghost" aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}
            className="w-full justify-start gap-2.5 px-2 font-normal aria-[current=page]:bg-muted aria-[current=page]:font-medium">
            <item.icon data-icon="inline-start" />{t(`category.${item.label}`)}
          </Button>
        </li>)}
      </ul>
    </aside>
    {/* The category is already selected on the left, so the table has no second 20px title (R-32). */}
    <section aria-label={t(`category.${current.label}`)} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 pt-6 pb-6 md:px-12">
      {error ? <InlineLoadError message={t('loadError')} retryLabel={t('retry')} onRetry={() => { void mutate() }} />
        : !data ? <div role="status" aria-label={t('loading')} className="flex flex-col gap-2">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-12 w-full" />)}</div>
        : !rows.length ? <Empty className="flex-1"><EmptyHeader><EmptyDescription>{t('empty')}</EmptyDescription></EmptyHeader></Empty>
        : <div className="flex flex-col">
          <div aria-hidden="true" className={cn(COLUMNS, 'h-10 px-2 text-xs text-muted-foreground')}>
            <span>{t('columns.name')}</span>
            <span className="hidden text-right md:block">{t('columns.source')}</span>
            <span className="text-right">{t('columns.updated')}</span>
          </div>
          <ul aria-label={t(`category.${current.label}`)} className="flex flex-col">
          {rows.map(item => <li key={item.id}>
            <Button variant="ghost" onClick={() => setOpen(item)} className={cn(COLUMNS, 'h-13 w-full rounded-none px-2 text-left font-normal')}>
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground"><ArtifactKindIcon kind={item.kind} className="size-4" /></span>
                <span className="truncate text-sm leading-5 font-medium">{item.title}</span>
              </span>
              <span className="hidden truncate text-right text-sm text-muted-foreground md:block">{source(item)}</span>
              <span className="truncate text-right text-sm text-muted-foreground"><time dateTime={item.updatedAt}>{format.relativeTime(new Date(item.updatedAt), now)}</time></span>
            </Button>
          </li>)}
          </ul>
        </div>}
    </section>
    {open && <ArtifactWindow artifact={open} onClose={() => setOpen(null)} onOpenIssue={onOpenIssue}
      onChange={id => setOpen(data?.find(item => item.id === id) ?? { id, runId: null, issueId: null, botId: null })} />}
  </div>
}
