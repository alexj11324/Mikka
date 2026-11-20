'use client'

/**
 * 自动化's list page as the open-source UI draws it (docs/ui-overlay.md). AutomationsPage
 * (components/automations/automations-page.tsx) owns the reads, filters and writes; a UI layer may draw its own page
 * from the same props (automations-contract.ts).
 */
import { Fragment, useState } from 'react'
import { useFormatter, useNow, useTranslations } from '@/lib/intl/i18n-client'
import { Blocks, Bot, CalendarClock, Ellipsis, Hand, Link, Pin, Plus, Rows3, SlidersHorizontal, SquarePen, X } from '@/components/icons'
import { GitHubIcon, LinearIcon, SlackIcon } from '@/components/icons/brand-icons'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { InlineLoadError } from '@/components/load-error'
import type { AutomationGrouping, AutomationRow, AutomationsPageProps, AutomationStatusFilter, AutomationTriggerKind } from './automations-contract'

const SlackMark = (_props: { className?: string }) => <SlackIcon />
const TRIGGER_ICONS = { schedule: CalendarClock, manual: Hand, github: GitHubIcon, linear: LinearIcon, slack: SlackMark, webhook: Link } satisfies Record<AutomationTriggerKind, unknown>
const statusVariant = { active: 'secondary', paused: 'outline', completed: 'outline', cancelled: 'outline' } as const

function TriggerIcon({ kind, small = false }: { kind: AutomationTriggerKind; small?: boolean }) {
  const Icon = TRIGGER_ICONS[kind]
  return small ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : <Icon aria-hidden="true" className="size-4 shrink-0" />
}

export function AutomationsPageView(props: AutomationsPageProps) {
  const t = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  const { filters, onFilters, display, onDisplay } = props
  const statusChip = filters.status !== 'all'
  const newButton = <Button size="sm" onClick={() => props.create.onOpenChange(true)}><Plus data-icon="inline-start" />{t('new')}</Button>

  return <section aria-labelledby="automations-title" className="flex min-h-0 flex-1 flex-col overflow-auto">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 id="automations-title" className="text-xl font-semibold text-foreground">{t('title')}</h1>
        {newButton}
      </header>
      <Tabs value={props.tab ?? ''} onValueChange={value => { if (value === 'mine' || value === 'all' || value === 'scheduled') props.onTab(value) }}>
        <TabsList variant="line" aria-label={t('title')}>
          {(['mine', 'all', 'scheduled'] as const).map(tab => <TabsTrigger key={tab} value={tab}>{t(`tabs.${tab}`)}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      {/* control-size-exempt: each chip's ✕ sits inside its badge, sized to the chip. */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput className="h-(--control-sm) min-w-0 flex-1 sm:max-w-64" type="search" value={props.query} maxLength={120} aria-label={t('search')} placeholder={t('search')} onChange={event => props.onQuery(event.target.value)} />
        {filters.creatorIsMe && <Chip label={t('chip.creatorIsMe')} remove={t('removeFilter')} onRemove={() => onFilters({ creatorIsMe: false })} />}
        {filters.scheduledOnly && <Chip label={t('chip.scheduled')} remove={t('removeFilter')} onRemove={() => onFilters({ scheduledOnly: false })} />}
        {statusChip && <Chip label={t('chip.status', { status: t(`filter.${filters.status}`) })} remove={t('removeFilter')} onRemove={() => onFilters({ status: 'all' })} />}
        {props.tag && <Chip label={t('tagFilter', { tag: props.tag })} remove={t('clearTag')} onRemove={() => props.onTag(null)} />}
        <div className="ms-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}><SlidersHorizontal data-icon="inline-start" />{t('filterMenu')}</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem checked={filters.creatorIsMe} onCheckedChange={checked => onFilters({ creatorIsMe: checked })}>{t('filterCreator')}</DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={filters.scheduledOnly} onCheckedChange={checked => onFilters({ scheduledOnly: checked })}>{t('filterScheduled')}</DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('filterStatus')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={filters.status} onValueChange={value => onFilters({ status: value as AutomationStatusFilter })}>
                  {(['all', 'active', 'paused', 'deleted'] as const).map(value => <DropdownMenuRadioItem key={value} value={value}>{t(`filter.${value}`)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}><Rows3 data-icon="inline-start" />{t('displayMenu')}</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('grouping')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={display.grouping} onValueChange={value => onDisplay({ grouping: value as AutomationGrouping })}>
                  <DropdownMenuRadioItem value="status">{t('groupStatus')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="folder">{t('groupFolder')}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={display.showTemplates} onCheckedChange={checked => onDisplay({ showTemplates: checked })}>{t('showTemplates')}</DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {props.error ? <InlineLoadError message={t('loadError')} retryLabel={tCommon('retry')} onRetry={props.onRetry} />
        : props.loading ? <div role="status" aria-label={t('loading')} className="flex flex-col gap-2">{[0, 1, 2].map(index => <Skeleton key={index} className="h-16 w-full rounded-xl" />)}</div>
          : props.empty ? <Empty className="min-h-56">
            <EmptyHeader><EmptyMedia variant="icon"><CalendarClock aria-hidden="true" /></EmptyMedia><EmptyTitle>{props.empty === 'deleted' ? t('emptyDeleted') : props.empty === 'filtered' ? t('emptyFiltered') : t('empty')}</EmptyTitle></EmptyHeader>
            <EmptyContent>{props.empty === 'none' ? newButton : <Button size="sm" variant="outline" onClick={props.onClearFilters}>{t('clearFilters')}</Button>}</EmptyContent>
          </Empty>
            : <div className="flex flex-col gap-4">{props.groups.map(group => <section key={group.key} aria-label={group.label} className="flex flex-col gap-2">
              <h2 className="flex items-center gap-1.5 px-1 text-sm font-medium text-muted-foreground">{group.key === 'pinned' && <Pin className="size-3.5" />}{group.label}<span className="tabular-nums">{group.count}</span></h2>
              <ItemGroup role="list" className="gap-0! overflow-hidden rounded-xl border bg-card">
                {group.rows.map((row, index) => <Fragment key={row.id}>{index > 0 && <ItemSeparator className="my-0" />}<AutomationRowItem row={row} {...props} /></Fragment>)}
              </ItemGroup>
            </section>)}</div>}
      {props.more && <Button variant="outline" disabled={props.loadingMore} onClick={props.onMore}>{t('more')}</Button>}
      {display.showTemplates && filters.status !== 'deleted' && props.templates.length > 0 && <section aria-labelledby="automation-templates" className="flex flex-col gap-2 pt-2">
        <h2 id="automation-templates" className="px-1 text-sm font-medium text-muted-foreground">{t('templatesTitle')}</h2>
        <TemplateGrid {...props} />
      </section>}
    </div>
    <CreateDialog {...props} />
    {props.dialogs}
  </section>
}

function Chip({ label, remove, onRemove }: { label: string; remove: string; onRemove: () => void }) {
  return <Badge variant="secondary" className="gap-1">{label}<Button size="icon-xs" variant="ghost" aria-label={remove} onClick={onRemove}><X /></Button></Badge>
}

function AutomationRowItem({ row, onOpen, onPin, onOrganize, onRestore, onPause, onViewRuns, onTag, restoring }: { row: AutomationRow } & AutomationsPageProps) {
  const t = useTranslations('Automations')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  return <Item role="listitem" className="rounded-none hover:bg-accent/50" render={row.deleted ? undefined : <a href={row.href} />} onClick={row.deleted ? undefined : event => onOpen(row.id, event)}>
    <ItemMedia variant="icon" className="text-muted-foreground"><TriggerIcon kind={row.trigger} /></ItemMedia>
    <ItemContent className="min-w-0">
      <ItemTitle className="w-full truncate">{row.title}</ItemTitle>
      <ItemDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{row.schedule}</span>
        {row.nextRun && <time dateTime={row.nextRun.at}>{t('nextRun', { time: row.nextRun.label })}</time>}
        {row.tags.map(name => <Button key={name} size="xs" variant="secondary" className="rounded-full"
          onClick={event => { event.preventDefault(); event.stopPropagation(); onTag(name) }}>#{name}</Button>)}
      </ItemDescription>
    </ItemContent>
    <ItemMedia className="hidden max-w-40 text-sm sm:flex">{row.handler}</ItemMedia>
    <ItemActions>
      {row.status !== 'active' && <Badge variant={statusVariant[row.status]}>{row.statusLabel}</Badge>}
      {row.creator && <Avatar className="size-5" title={row.creator.name}><AvatarImage src={row.creator.image ?? undefined} alt="" /><AvatarFallback className="text-xs">{row.creator.name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>}
      {row.updatedAt && <time className="hidden w-16 text-right text-xs text-muted-foreground tabular-nums sm:block" dateTime={row.updatedAt}>{format.relativeTime(new Date(Math.min(Date.parse(row.updatedAt), now.getTime())), now)}</time>}
      {row.deleted ? row.canRestore && <Button size="sm" variant="outline" disabled={restoring !== null} aria-busy={restoring === row.id} onClick={() => onRestore(row)}>{t('restore')}</Button> : <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t('rowMenu')} onClick={event => { event.preventDefault(); event.stopPropagation() }} />}><Ellipsis /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => onViewRuns(row)}>{t('viewRuns')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onPin(row)}>{row.pinned ? t('unpin') : t('pin')}</DropdownMenuItem>
            {row.canPause && <DropdownMenuItem onClick={() => onPause(row, row.status === 'active')}>{row.status === 'active' ? t('editor.pause') : t('editor.resume')}</DropdownMenuItem>}
            {row.canOrganize && <DropdownMenuItem onClick={() => onOrganize(row)}>{t('organize')}</DropdownMenuItem>}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    </ItemActions>
  </Item>
}

function TemplateGrid({ templates, onTemplate }: Pick<AutomationsPageProps, 'templates' | 'onTemplate'>) {
  return <div className="grid gap-2 sm:grid-cols-2">
    {templates.map(template => <Button key={template.id} variant="outline" onClick={() => onTemplate(template.id)}
      className="h-auto flex-col items-start justify-start gap-1.5 whitespace-normal rounded-xl p-3 text-left font-normal">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><TriggerIcon kind={template.trigger} small />{template.triggerLabel}</span>
      <span className="text-sm font-medium text-foreground">{template.title}</span>
      <span className="line-clamp-2 text-xs text-muted-foreground">{template.description}</span>
    </Button>)}
  </div>
}

/** 新建自动化: 从零开始, 从模板开始 (a second step lists the templates) or 让 Mikka 帮你建. */
function CreateDialog({ create, templates, onTemplate }: AutomationsPageProps) {
  const t = useTranslations('Automations')
  const [step, setStep] = useState<'choose' | 'templates'>('choose')
  const options = [
    { key: 'scratch', icon: SquarePen, title: t('fromScratch'), description: t('create.scratchDescription'), run: create.onScratch },
    { key: 'template', icon: Blocks, title: t('fromTemplate'), description: t('create.templateDescription'), run: () => setStep('templates') },
    { key: 'bot', icon: Bot, title: t('create.askBot'), description: t('create.askBotDescription'), run: create.onAskBot },
  ]
  return <Dialog open={create.open} onOpenChange={open => { create.onOpenChange(open); if (!open) setStep('choose') }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{step === 'templates' ? t('fromTemplate') : t('create.title')}</DialogTitle></DialogHeader>
      {step === 'choose' ? <div className="flex flex-col gap-2">
        {options.map(option => <Button key={option.key} variant="outline" onClick={option.run}
          className="h-auto items-start justify-start gap-3 whitespace-normal rounded-xl p-3 text-left font-normal">
          <option.icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col gap-0.5"><span className="text-sm font-medium">{option.title}</span><span className="text-xs text-muted-foreground">{option.description}</span></span>
        </Button>)}
      </div> : <div className="flex flex-col gap-3">
        <TemplateGrid templates={templates} onTemplate={onTemplate} />
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setStep('choose')}>{t('create.back')}</Button>
      </div>}
    </DialogContent>
  </Dialog>
}
