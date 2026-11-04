'use client'
import { useLocale, useTranslations } from 'next-intl'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, FileText, LocateFixed, MessageSquare, Minus, Plus, Scan, ShieldCheck, User, X } from 'lucide-react'
import { getProjectMap, getProjectMapNode } from '@/app/actions/project-map'
import type { ProjectMapNode, CheckState, MapStep, OwnerState } from '@/lib/project-map/server'
import { branchAncestry, buildMapGraph, layoutMap, pathHighlight, type MapGraph, type MapRow } from '@/lib/project-map/build'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ResizablePane } from '@/components/ui/resizable-pane'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { LaneGraph, laneGraphHeight, type LaneGraphRow, type LaneMarker } from '@/components/ui/lane-graph'
import { HarnessMark } from '@/components/labels/entity-labels'
import { ThreadStatusIcon } from './thread-status-icon'
import { PullRequestIcon } from './pull-request-icon'
import { navigate } from './workspace-navigation'
import { ISSUE_STATUSES } from './issue-properties'
import { useViewState } from '@/lib/hooks/view-state'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { statusIconTints } from '@/lib/status-appearance'
import type { Project } from './project-properties'

type Filter = 'all' | 'main' | 'abandoned' | 'artifacts'
type Translate = ReturnType<typeof useTranslations<'Projects.map'>>
type ForkRow = Extract<MapRow, { kind: 'fork' }>
const FILTERS: Filter[] = ['all', 'main', 'abandoned', 'artifacts']
const ZOOMS = [60, 80, 100, 120, 140]
const STEPS: MapStep[] = ['execute', 'review', 'verify', 'owner']

/** Desktop draws lanes 0–2 beside a date gutter; a phone lanes 0–1 with none (R-83). */
const GEOMETRY = {
  desktop: { lane0: 92, step: 32, offset: 20, right: 24, maxLane: 2, gutter: true, fork: 36 },
  phone: { lane0: 18, step: 18, offset: 14, right: 16, maxLane: 1, gutter: false, fork: 58 },
} as const
const HEIGHT = { node: 64, fold: 44 } as const

function useNarrow() {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)')
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}

const isAbandoned = (node: ProjectMapNode) => node.status === 'canceled' || node.status === 'duplicate'
const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1] ?? ''
const ownThread = (node: ProjectMapNode | undefined) => node?.threads.find(thread => thread.ownedByCurrentUser) ?? null
const openThread = (issueId: string, rootRunId: string) => navigate({ issue: issueId, thread: rootRunId })

function markerOf(node: ProjectMapNode): LaneMarker {
  if (isAbandoned(node)) return 'abandoned'
  if (node.status === 'done') return 'done'
  return node.status === 'doing' || node.status === 'review' ? 'active' : 'idle'
}

export function ProjectMap({ project, onOpenIssue, onCreateIssue }: { project: Project; onOpenIssue: (id: string) => boolean; onCreateIssue: () => void }) {
  const t = useTranslations('Projects.map')
  const { data, error, isLoading, mutate } = useSWR(['project-map', project.id, project.revision, project.issueIds.join()], async () => {
    const result = await getProjectMap(project.id)
    if (result.error) throw new Error(result.error)
    return result.map
  }, { revalidateOnFocus: false })
  if (error) return <div className="flex flex-col items-start gap-3 px-6 py-10"><p className="text-sm text-muted-foreground">{t('loadFailed')}</p><Button variant="outline" size="sm" onClick={() => void mutate()}>{t('reload')}</Button></div>
  if (isLoading || !data) return <div role="status" className="flex items-center gap-2 px-6 py-10 text-sm text-muted-foreground"><Spinner />{t('loading')}</div>
  if (!data.nodes.length) return <div className="flex items-center gap-3 px-6 py-10"><p className="text-sm text-muted-foreground">{t('noIssues')}</p><Button variant="outline" size="sm" onClick={onCreateIssue}><Plus data-icon="inline-start" />{t('newIssue')}</Button></div>
  return <MapView key={project.id} projectId={project.id} nodes={data.nodes} onOpenIssue={onOpenIssue} />
}

function MapView({ projectId, nodes, onOpenIssue }: { projectId: string; nodes: ProjectMapNode[]; onOpenIssue: (id: string) => boolean }) {
  const t = useTranslations('Projects.map')
  const locale = useLocale()
  const narrow = useNarrow()
  const geometry = narrow ? GEOMETRY.phone : GEOMETRY.desktop
  const [filter, setFilter] = useViewState<Filter>(`project:${projectId}:map:filter`, 'all')
  const [query, setQuery] = useViewState(`project:${projectId}:map:query`, '')
  const [selected, setSelected] = useViewState<string | null>(`project:${projectId}:map:selected`, null)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [foldAll, setFoldAll] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(100)
  const scroller = useRef<HTMLDivElement>(null)
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])
  const graph = useMemo(() => buildMapGraph(nodes), [nodes])
  const single = nodes.length < 2
  const layout = useMemo(() => layoutMap(graph, { maxLane: geometry.maxLane, folded, foldAll: foldAll || filter === 'main', focusId }), [graph, geometry.maxLane, folded, foldAll, filter, focusId])
  const selectedNode = selected ? byId.get(selected) ?? null : null
  const highlight = useMemo(() => pathHighlight(graph, layout, selectedNode?.id ?? null), [graph, layout, selectedNode])
  const needle = query.trim().toLowerCase()
  const fading = filter === 'abandoned' || filter === 'artifacts' || !!needle
  const matches = (row: MapRow) => {
    if (row.kind === 'fork') return !needle || decisionText(t, row, byId).toLowerCase().includes(needle)
    const node = byId.get(row.kind === 'node' ? row.id : row.branchId)!
    if (filter === 'abandoned' && !(row.kind === 'fold' ? row.abandoned : isAbandoned(node))) return false
    if (filter === 'artifacts' && !node.artifacts.length) return false
    if (!needle) return true
    return [node.title, node.identifier ?? '', node.reason?.text ?? '', ...node.artifacts.map(item => item.title), ...node.pullRequests.map(pr => pr.title ?? '')].some(text => text.toLowerCase().includes(needle))
  }
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && selected && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, [role="dialog"]'))) setSelected(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [selected, setSelected])
  const dayFormat = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  let lastDay = ''
  const rows: LaneGraphRow[] = layout.rows.map(row => {
    const faded = fading && !matches(row)
    if (row.kind === 'node') {
      const node = byId.get(row.id)!
      const day = dayFormat.format(new Date(node.createdAt))
      const label = day !== lastDay ? day : undefined
      lastDay = day
      const fold = row.lane > 0 && isBranchRoot(graph, node.id) ? () => setFolded(current => new Set(current).add(node.id)) : undefined
      return { key: row.key, lane: row.lane, height: HEIGHT.node, marker: markerOf(node), current: node.id === graph.currentId, label, labelDateTime: node.createdAt, faded, children: <NodeCard node={node} selected={selected === node.id} highlighted={highlight.rows.has(layout.rows.indexOf(row))} onSelect={() => setSelected(selected === node.id ? null : node.id)} onFold={fold} /> }
    }
    if (row.kind === 'fork') return { key: row.key, lane: row.lane, height: geometry.fork, marker: 'fork', faded, width: 'content', children: <ForkLine row={row} narrow={narrow} byId={byId} /> }
    const root = byId.get(row.branchId)!
    return { key: row.key, lane: row.lane, height: HEIGHT.fold, marker: 'fold', faded, children: <FoldRow row={row} root={root} onOpen={() => row.deep ? setFocusId(row.branchId) : setFolded(current => { const next = new Set(current); next.delete(row.branchId); return next })} onSelect={() => setSelected(root.id)} /> }
  })
  function fit() {
    const box = scroller.current
    if (!box) return
    const ratio = box.clientHeight / laneGraphHeight(rows) * 100
    setZoom(ZOOMS.filter(step => step <= 100 && step <= Math.max(ratio, ZOOMS[0])).at(-1) ?? ZOOMS[0])
  }
  function locate() {
    const id = graph.currentId
    if (!id) return
    setFocusId(null)
    requestAnimationFrame(() => scroller.current?.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }))
  }
  const ancestry = focusId ? branchAncestry(graph, focusId) : []
  const detail = selectedNode && <NodeDetail projectId={projectId} node={selectedNode} graph={graph} byId={byId} onClose={() => setSelected(null)} onSelect={setSelected} onOpenIssue={onOpenIssue} locale={locale} />
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <ToggleGroup aria-label={t('filterLabel')} variant="segment" size="sm" spacing={0.5} value={[filter]} disabled={single} onValueChange={values => { const next = values[0] as Filter | undefined; if (next) setFilter(next) }}>
          {FILTERS.map(value => <ToggleGroupItem key={value} value={value}>{t(`filter.${value}`)}</ToggleGroupItem>)}
        </ToggleGroup>
        <SearchInput aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} className="h-7 w-full sm:w-60" />
        <div className="flex-1" />
        <Button variant="outline" size="icon-sm" disabled={single} aria-label={foldAll ? t('unfoldAll') : t('foldAll')} title={foldAll ? t('unfoldAll') : t('foldAll')} aria-pressed={foldAll} onClick={() => setFoldAll(value => !value)}>{foldAll ? <ChevronsUpDown /> : <ChevronsDownUp />}</Button>
        {!narrow && <div className="flex items-center gap-0.5">
          <Button variant="outline" size="icon-sm" disabled={single || zoom <= ZOOMS[0]} aria-label={t('zoomOut')} title={t('zoomOut')} onClick={() => setZoom(value => ZOOMS[Math.max(0, ZOOMS.indexOf(value) - 1)])}><Minus /></Button>
          <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">{zoom}%</span>
          <Button variant="outline" size="icon-sm" disabled={single || zoom >= ZOOMS[ZOOMS.length - 1]} aria-label={t('zoomIn')} title={t('zoomIn')} onClick={() => setZoom(value => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(value) + 1)])}><Plus /></Button>
          <Button variant="outline" size="icon-sm" disabled={single} aria-label={t('fit')} title={t('fit')} onClick={fit}><Scan /></Button>
        </div>}
        <Button variant="outline" size="icon-sm" aria-label={t('locate')} title={t('locate')} disabled={!graph.currentId} onClick={locate}><LocateFixed /></Button>
      </div>
      {focusId && <Breadcrumb aria-label={t('breadcrumb')} className="px-4 pb-2"><BreadcrumbList>
        <BreadcrumbItem><Button variant="ghost" size="sm" onClick={() => setFocusId(null)}>{t('main')}</Button></BreadcrumbItem>
        {ancestry.map((id, index) => <Fragment key={id}><BreadcrumbSeparator /><BreadcrumbItem>{index === ancestry.length - 1 ? <BreadcrumbPage>{byId.get(id)?.title}</BreadcrumbPage> : <Button variant="ghost" size="sm" onClick={() => setFocusId(id)}>{byId.get(id)?.title}</Button>}</BreadcrumbItem></Fragment>)}
      </BreadcrumbList></Breadcrumb>}
      <LaneGraph rows={rows} lanes={[...layout.lanes, ...highlight.lanes.map(line => ({ ...line, kind: 'highlight' as const }))]} branches={[...layout.branches, ...highlight.branches.map(line => ({ ...line, kind: 'highlight' as const }))]} geometry={geometry} zoom={narrow ? 100 : zoom} minimapLabel={narrow || single ? undefined : t('minimap')} scrollerRef={scroller} />
      {single && <div className="flex items-center gap-3 px-6 py-4"><p className="text-sm text-muted-foreground">{t('onlyStart')}</p><Button variant="outline" size="sm" onClick={() => onOpenIssue(nodes[0].id)}>{t('splitWithBot')}</Button></div>}
    </div>
    {selectedNode && !narrow && <ResizablePane render="aside" aria-label={t('detail')} storageKey="mikka:project-map-detail-width" defaultWidth={400} min={320} max={560} edge="start" from="lg" label={t('resize')} className="flex min-h-0 w-full shrink-0 flex-col overflow-y-auto">{detail}</ResizablePane>}
    {narrow && <Sheet open={!!selectedNode} onOpenChange={open => { if (!open) setSelected(null) }}>
      <SheetContent side="bottom" instant showCloseButton={false} className="max-h-[72dvh] gap-0 overflow-y-auto rounded-t-2xl border-t-0 pb-[env(safe-area-inset-bottom)]">
        <SheetTitle className="sr-only">{selectedNode?.title ?? t('detail')}</SheetTitle>
        <div aria-hidden="true" className="mx-auto mt-2 h-1.5 w-9 shrink-0 rounded-full bg-control" />
        {detail}
      </SheetContent>
    </Sheet>}
  </div>
}

function isBranchRoot(graph: MapGraph, id: string) {
  const pred = graph.predecessor.get(id)
  return !!pred && graph.children.get(pred)!.length > 1 && graph.continues.get(pred) !== id
}

function decisionText(t: Translate, row: ForkRow, byId: Map<string, ProjectMapNode>) {
  const title = (id: string) => byId.get(id)?.title ?? ''
  return row.parallel
    ? t('parallel', { items: [row.chosenId, ...row.otherIds].map(title).join(' + ') })
    : t('chose', { chosen: title(row.chosenId), dropped: row.otherIds.map(title).join('、') })
}

function forkReason(row: ForkRow, byId: Map<string, ProjectMapNode>) {
  for (const id of row.otherIds) { const node = byId.get(id); if (node?.reason) return { node, reason: node.reason } }
  return null
}

function forkOf(graph: MapGraph, id: string): ForkRow | null {
  const parent = graph.predecessor.get(id)
  const kids = parent ? graph.children.get(parent)! : []
  if (!parent || kids.length < 2) return null
  const chosenId = graph.continues.get(parent)!
  const otherIds = kids.filter(kid => kid !== chosenId)
  return { kind: 'fork', key: `fork:${parent}`, parentId: parent, lane: 0, chosenId, otherIds, parallel: otherIds.some(kid => !graph.branchAbandoned.has(kid)) }
}

function StatusMark({ status, small = false, inButton = false }: { status: string; small?: boolean; inButton?: boolean }) {
  const item = ISSUE_STATUSES.find(entry => entry.value === status) ?? ISSUE_STATUSES[1]
  const Icon = item.icon
  return <Icon aria-hidden="true" data-icon={inButton ? 'inline-start' : undefined} className={cn('shrink-0', small ? 'size-3' : 'size-4', statusIconTints[item.tone])} />
}

function CheckIcon({ step, state }: { step: 'review' | 'verify' | 'owner'; state: CheckState | OwnerState }) {
  const good = state === 'passed' || state === 'approved' || state === 'merged'
  const bad = state === 'failed' || state === 'changesRequested'
  if (step === 'review') return <Eye className={cn(good && 'text-success', bad && 'text-destructive', !good && !bad && 'text-warning')} />
  if (step === 'verify') return <ShieldCheck className={cn(good && 'text-success', bad && 'text-destructive', !good && !bad && 'text-warning')} />
  return <User className={cn(good && 'text-success', bad && 'text-destructive', !good && !bad && 'text-warning')} />
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="flex shrink-0 items-center gap-1 rounded-md bg-control px-1.5 text-xs text-muted-foreground [&_svg]:size-3">{icon}{children}</span>
}

function NodeCard({ node, selected, highlighted, onSelect, onFold }: { node: ProjectMapNode; selected: boolean; highlighted: boolean; onSelect: () => void; onFold?: () => void }) {
  const t = useTranslations('Projects.map')
  const abandoned = isAbandoned(node)
  const pr = node.pullRequests[0]
  const factory = node.factory
  const sub = abandoned
    ? [factory ? t('stoppedAt', { step: t(`step.${factory.step}`) }) : null, node.reason?.text].filter(Boolean).join(' · ')
    : ownThread(node)?.summary ?? ''
  return <div className="group/node relative size-full">
    <Button variant="ghost" aria-pressed={selected} onClick={onSelect} className={cn('size-full items-start justify-start gap-3 rounded-xl px-4 py-3 text-left font-normal whitespace-normal',
      abandoned ? 'border border-dashed border-rule bg-transparent hover:bg-control' : 'bg-card shadow-xs hover:bg-accent aria-pressed:bg-card',
      selected && 'ring-2 ring-sidebar-primary', !selected && highlighted && 'ring-1 ring-sidebar-primary/50')}>
      <span className="pt-0.5"><StatusMark status={node.status} inButton /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-sm font-medium', abandoned && 'text-muted-foreground')}>{node.title}</span>
          {node.identifier && <span className="shrink-0 font-mono text-xs text-muted-foreground/70">{node.identifier}</span>}
          <span className="flex-1" />
          <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
            {node.artifacts.length > 0 && <Chip icon={<FileText data-icon="inline-start" />}>{t('artifactCount', { count: node.artifacts.length })}</Chip>}
            {pr && <Chip icon={<PullRequestIcon state={pr.state} />}>#{prNumber(pr.url)}</Chip>}
            {factory?.verify ? <Chip icon={<CheckIcon step="verify" state={factory.verify.state} />}>{t('step.verify')}</Chip> : factory?.review ? <Chip icon={<CheckIcon step="review" state={factory.review} />}>{t('step.review')}</Chip> : null}
          </span>
        </span>
        {sub && <span className={cn('truncate text-xs', abandoned ? 'text-muted-foreground/70' : 'text-muted-foreground')}>{sub}</span>}
      </span>
    </Button>
    {onFold && <Button variant="ghost" size="icon-xs" aria-label={t('foldBranch')} title={t('foldBranch')} className="absolute top-5 -left-7 opacity-0 group-hover/node:opacity-100 focus-visible:opacity-100" onClick={onFold}><ChevronsDownUp /></Button>}
  </div>
}

function ForkLine({ row, narrow, byId }: { row: ForkRow; narrow: boolean; byId: Map<string, ProjectMapNode> }) {
  const t = useTranslations('Projects.map')
  const why = forkReason(row, byId)
  const target = why?.node ?? byId.get(row.otherIds[0])
  const thread = ownThread(target)
  return <div className={cn('flex min-w-0 gap-x-2 rounded-lg bg-control px-3 py-2 text-sm', narrow ? 'flex-col items-start gap-y-0.5' : 'items-center')}>
    <span className="min-w-0 truncate font-medium">{decisionText(t, row, byId)}</span>
    {why && <span className={cn('min-w-0 truncate text-muted-foreground', narrow && 'text-xs')}>{narrow ? why.reason.text : `· ${why.reason.text}`}</span>}
    {thread && target && <Button variant="link" size="xs" className="h-auto shrink-0 px-0 text-sidebar-primary" onClick={() => openThread(target.id, thread.rootRunId)}><MessageSquare data-icon="inline-start" />{t('conversation')}</Button>}
  </div>
}

function FoldRow({ row, root, onOpen, onSelect }: { row: Extract<MapRow, { kind: 'fold' }>; root: ProjectMapNode; onOpen: () => void; onSelect: () => void }) {
  const t = useTranslations('Projects.map')
  return <div className="flex size-full items-center gap-2 rounded-xl border border-dashed border-rule px-3">
    <Button variant="ghost" size="icon-xs" aria-label={row.deep ? t('openBranch') : t('unfoldBranch')} title={row.deep ? t('openBranch') : t('unfoldBranch')} onClick={onOpen}><ChevronRight /></Button>
    <StatusMark status={root.status} />
    <Button variant="ghost" size="sm" className="min-w-0 justify-start truncate px-1 font-medium text-muted-foreground" onClick={onSelect}>{root.title}</Button>
    <span className="shrink-0 rounded-md bg-control px-1.5 text-xs text-muted-foreground">{t('steps', { count: row.count })}</span>
    <span className="flex-1" />
    {row.abandoned && root.factory && <span className="hidden truncate text-xs text-muted-foreground/70 sm:block">{t('stoppedAt', { step: t(`step.${root.factory.step}`) })}</span>}
  </div>
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <section className="flex flex-col gap-2.5"><h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{title}{count !== undefined && <span className="font-normal text-muted-foreground/70">{count}</span>}</h3>{children}</section>
}

function NodeDetail({ projectId, node, graph, byId, onClose, onSelect, onOpenIssue, locale }: { projectId: string; node: ProjectMapNode; graph: MapGraph; byId: Map<string, ProjectMapNode>; onClose: () => void; onSelect: (id: string) => void; onOpenIssue: (id: string) => boolean; locale: string }) {
  const t = useTranslations('Projects.map')
  const tStatus = useTranslations('Issue.status')
  const { data: extra } = useSWR(['project-map-node', projectId, node.id, node.updatedAt], () => getProjectMapNode(projectId, node.id), { revalidateOnFocus: false })
  const abandoned = isAbandoned(node)
  const fork = forkOf(graph, node.id)
  const why = fork ? forkReason(fork, byId) : null
  const whyThread = why ? ownThread(why.node) : null
  const thread = ownThread(node)
  const factory = node.factory
  const dateFormat = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  const statusName = tStatus.has(node.status as never) ? tStatus(node.status as never) : node.status
  const alternatives = fork ? (node.id === fork.chosenId ? fork.otherIds : [fork.chosenId]) : []
  const alternativeLabel = !fork ? '' : node.id === fork.chosenId ? (fork.parallel ? t('parallelBranch') : t('droppedBranch')) : abandoned ? t('switchedTo') : t('parallelBranch')
  const reached = factory ? STEPS.indexOf(factory.step) : -1
  return <div className="flex flex-col gap-6 px-6 pt-5 pb-8">
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-2"><StatusMark status={node.status} />{node.identifier && <span className="font-mono text-xs text-muted-foreground/70">{node.identifier}</span>}<span className="flex-1" /><Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X /></Button></div>
      <h2 className="text-lg font-semibold text-balance">{node.title}</h2>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
        <span className={cn('rounded-md px-2 font-medium', node.status === 'done' ? 'bg-success/15 text-success-foreground' : node.status === 'doing' || node.status === 'review' ? 'bg-warning/15 text-warning-foreground' : 'bg-control text-muted-foreground')}>{statusName}</span>
        {thread?.harness && <span className="flex items-center gap-1 text-muted-foreground [&_svg]:size-3.5"><HarnessMark harness={thread.harness} />{thread.agentName}</span>}
        <span className="text-muted-foreground/70">{dateFormat.format(new Date(node.createdAt))} – {dateFormat.format(new Date(node.updatedAt))}</span>
      </div>
    </header>
    <Section title={t('section.task')}>
      <p className="text-sm leading-5.25">{extra && !extra.error ? extra.description || <span className="text-muted-foreground">{t('noDescription')}</span> : <span className="text-muted-foreground">…</span>}</p>
      <Button variant="outline" size="sm" className="self-start" onClick={() => onOpenIssue(node.id)}>{t('openTask')}</Button>
    </Section>
    {fork && <Section title={t('section.decision')}>
      <div className="flex flex-col gap-1.5 rounded-xl bg-muted/60 p-4">
        <p className="text-sm font-medium">{decisionText(t, fork, byId)}</p>
        {why && <p className="text-sm leading-5.25 text-muted-foreground">{why.reason.text}</p>}
        {why && <div className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground/70">
          <span>{t(`source.${why.reason.source}`)}</span>
          {whyThread && <><span>·</span><Button variant="link" size="xs" className="h-auto px-0 text-sidebar-primary" onClick={() => openThread(why.node.id, whyThread.rootRunId)}><MessageSquare data-icon="inline-start" />{t('viewConversation')}</Button></>}
        </div>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground/70">
        <span>{alternativeLabel}</span>
        {alternatives.map(id => { const other = byId.get(id); return other && <Button key={id} variant="ghost" size="xs" className="max-w-full bg-object-chip text-object-chip-foreground hover:bg-object-chip-hover" onClick={() => onSelect(id)}><StatusMark status={other.status} small inButton /><span className="truncate">{other.title}</span></Button> })}
      </div>
    </Section>}
    {abandoned && factory && <Section title={t('section.stopped')}>
      <ol className="flex items-start gap-2">{STEPS.map((step, index) => <li key={step} className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex flex-col items-center gap-1">
          <span className={cn('size-3 rounded-full', index < reached ? 'bg-success' : index === reached ? 'bg-destructive' : 'border border-muted-foreground/50')} />
          <span className={cn('text-xs', index === reached ? 'font-medium text-destructive' : 'text-muted-foreground')}>{t(`step.${step}`)}</span>
        </span>
        {index < STEPS.length - 1 && <span className={cn('mb-5 h-px flex-1', index < reached ? 'bg-success' : 'bg-rule')} />}
      </li>)}</ol>
    </Section>}
    {node.artifacts.length > 0 && <Section title={t('section.artifacts')} count={node.artifacts.length}>
      <ul className="-mx-2 flex flex-col">{node.artifacts.map(item => <li key={item.id}><Button variant="ghost" className="h-9 w-full justify-start gap-2.5 px-2 font-normal" onClick={() => navigate({ artifact: item.id })}><FileText data-icon="inline-start" className="text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-left">{item.title}</span><span className="shrink-0 text-xs text-muted-foreground/70">{t('version', { version: item.latestVersion })} · {dateFormat.format(new Date(item.updatedAt))}</span></Button></li>)}</ul>
    </Section>}
    {node.pullRequests.length > 0 && <Section title={t('section.pullRequests')} count={node.pullRequests.length}>
      <ul className="-mx-2 flex flex-col">{node.pullRequests.map(pr => <li key={pr.url}><a href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-accent [&_svg]:size-4"><PullRequestIcon state={pr.state} /><span className="min-w-0 flex-1 truncate">#{prNumber(pr.url)} {pr.title}</span>{pr.additions !== undefined && <span className="shrink-0 text-xs tabular-nums"><span className="text-success-foreground">+{pr.additions}</span> <span className="text-destructive">−{pr.deletions ?? 0}</span></span>}</a></li>)}</ul>
    </Section>}
    {factory && (factory.review || factory.verify || factory.owner) && <Section title={t('section.checks')}>
      <dl className="flex flex-col gap-0.5 text-sm">
        {factory.review && <CheckRow icon={<CheckIcon step="review" state={factory.review} />} label={t('step.review')} value={t(`check.${factory.review}`)} />}
        {factory.verify && <CheckRow icon={<CheckIcon step="verify" state={factory.verify.state} />} label={t('step.verify')} value={factory.verify.total ? `${t(`check.${factory.verify.state}`)} · ${t('verifyCount', { passed: factory.verify.passed, total: factory.verify.total })}` : t(`check.${factory.verify.state}`)} />}
        {factory.owner && <CheckRow icon={<CheckIcon step="owner" state={factory.owner.state} />} label={t('step.owner')} value={[factory.owner.name, t(`check.${factory.owner.state}`), dateFormat.format(new Date(factory.owner.at))].filter(Boolean).join(' · ')} />}
      </dl>
    </Section>}
    {thread?.summary && <Section title={t('section.summary')}>
      <p className="text-sm leading-5.25">{thread.summary}</p>
      <Button variant="link" size="xs" className="h-auto self-start px-0 text-sidebar-primary" onClick={() => openThread(node.id, thread.rootRunId)}><MessageSquare data-icon="inline-start" />{t('viewConversation')}</Button>
    </Section>}
    {node.threads.length > 0 && <Section title={t('section.threads')} count={node.threads.length}>
      <ul className="-mx-2 flex flex-col">{node.threads.map(item => {
        const body = <><ThreadStatusIcon status={item.status} outcome={item.outcome} /><span className="min-w-0 flex-1 truncate text-left">{item.name ?? item.ownerName}</span><span className="shrink-0 text-xs text-muted-foreground/70">{relativeTime(item.createdAt, locale)}</span></>
        return <li key={item.rootRunId}>{item.ownedByCurrentUser
          ? <Button variant="ghost" className="h-9 w-full justify-start gap-2.5 px-2 font-normal" onClick={() => openThread(node.id, item.rootRunId)}>{body}</Button>
          : <div className="flex h-9 items-center gap-2.5 px-2 text-sm">{body}</div>}</li>
      })}</ul>
    </Section>}
  </div>
}

function CheckRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="flex items-center gap-2.5 py-1.5 [&_svg]:size-4 [&_svg]:shrink-0">{icon}<dt>{label}</dt><dd className="ml-auto truncate text-xs text-muted-foreground">{value}</dd></div>
}
