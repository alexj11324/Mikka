'use client'

import { useRef, useState } from 'react'
import { ChartNoAxesColumnIncreasing, GripVertical, Plus } from 'lucide-react'
import { moveIssue, type listIssues } from '@/app/actions/issues'
import { Kanban, KanbanBoard, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay, type KanbanCommitMeta } from '@/components/reui/kanban'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier, type IssueStatus } from './issue-properties'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Columns = Record<string, Issue[]>

function groupIssues(issues: Issue[]): Columns {
  return Object.fromEntries(ISSUE_STATUSES.map(status => [status.value, issues.filter(issue => issue.status === status.value)]))
}

export function IssueBoard({ issues, onOpen, onCreate, onUpdated, onBusyChange }: {
  issues: Issue[]
  onOpen: (id: string) => void
  onCreate: (status: IssueStatus) => void
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const [columns, setColumns] = useState<Columns>(() => groupIssues(issues))
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const saving = useRef(false)

  async function persist(issue: Issue, status: string, rollback: Columns) {
    if (saving.current) return
    saving.current = true
    setPending(true)
    onBusyChange(true)
    setMessage('正在保存任务状态…')
    try {
      const result = await moveIssue({ id: issue.id, status, revision: issue.revision })
      if (!('issue' in result) || !result.issue) throw new Error(result.error ?? '移动失败，请重试。')
      setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.map(item => item.id === issue.id ? { ...item, status, revision: result.issue!.revision, updatedAt: result.issue!.updatedAt } : item)])))
      setMessage(`已移至${ISSUE_STATUSES.find(item => item.value === status)?.label}`)
    } catch (error) {
      setColumns(rollback)
      setMessage(error instanceof Error ? error.message : '状态保存失败，已恢复原位置。')
    } finally {
      saving.current = false
      setPending(false)
      onBusyChange(false)
      void onUpdated().catch(() => {})
    }
  }

  function commit(next: Columns, meta: KanbanCommitMeta<Issue>) {
    if (meta.kind !== 'item' || meta.activeContainer === meta.overContainer) {
      setColumns(meta.previousValue)
      return
    }
    const issue = meta.previousValue[meta.activeContainer]?.find(item => item.id === String(meta.event.active.id))
    if (!issue) { setColumns(meta.previousValue); return }
    setColumns(next)
    void persist(issue, meta.overContainer, meta.previousValue)
  }

  function changeStatus(issue: Issue, status: string) {
    if (saving.current) return
    const previous = columns
    setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, key === status ? [issue, ...items.filter(item => item.id !== issue.id)] : items.filter(item => item.id !== issue.id)])))
    void persist(issue, status, previous)
  }

  return <section aria-label="任务看板" className="flex min-w-0 flex-1 flex-col gap-3 px-4 pb-6 sm:px-6">
    <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{message || '拖动手柄跨列更新状态，列内按最近更新排序。'}</p>
    <div className="min-w-0 overflow-x-auto pb-3">
      <Kanban value={columns} onValueChange={setColumns} getItemValue={item => item.id} onValueCommit={commit} restoreOnCancel onDragStart={() => onBusyChange(true)} onDragCancel={() => onBusyChange(false)} onDragEnd={() => { if (!saving.current) onBusyChange(false) }} accessibility={{ screenReaderInstructions: { draggable: '按空格开始拖动，使用方向键移动到目标状态列，再按空格放下，按 Escape 取消。' } }}>
        <KanbanBoard className="grid min-w-260 grid-cols-4 items-start gap-5">
          {ISSUE_STATUSES.map(status => <KanbanColumn key={status.value} value={status.value}>
            <header className="flex items-center justify-between gap-2 px-1 pb-3">
              <div className="flex items-center gap-2"><status.icon className="size-4 text-muted-foreground" /><h2 className="text-sm font-medium">{status.label}</h2><Badge variant="outline">{columns[status.value]?.length ?? 0}</Badge></div>
              <Button variant="ghost" size="icon-xs" aria-label={`新建${status.label}任务`} disabled={pending} onClick={() => onCreate(status.value)}><Plus /></Button>
            </header>
            <KanbanColumnContent value={status.value} aria-label={`${status.label}列`} className="min-h-96 gap-2 rounded-lg bg-muted/30 p-1.5">
              {(columns[status.value] ?? []).map(issue => <KanbanItem key={issue.id} value={issue.id} disabled={pending} role="group" tabIndex={-1} aria-label={issue.title}>
                <Card size="sm">
                  <CardHeader>
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-muted-foreground">{issueIdentifier(issue.id)}</span>
                      <KanbanItemHandle render={<Button variant="ghost" size="icon-xs" aria-label={`拖动任务：${issue.title}`} aria-roledescription="可拖动任务" disabled={pending} />}><GripVertical /></KanbanItemHandle>
                    </div>
                    <CardTitle><button type="button" disabled={pending} onClick={() => onOpen(issue.id)} className="w-full rounded-sm text-left leading-6 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{issue.title}</button></CardTitle>
                  </CardHeader>
                  <CardContent><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><ChartNoAxesColumnIncreasing className="size-3.5" /><span>{ISSUE_PRIORITIES.find(item => item.value === issue.priority)?.label}</span></div></CardContent>
                  <CardFooter className="justify-between gap-2">
                    <IssuePropertyMenu label="移动到" value={status.value} options={ISSUE_STATUSES} icon={status.icon} disabled={pending} onChange={value => changeStatus(issue, value)} />
                    <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={new Date(issue.updatedAt).toISOString()}>{new Date(issue.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</time>
                  </CardFooter>
                </Card>
              </KanbanItem>)}
              {!columns[status.value]?.length && <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">拖动任务到这里</div>}
            </KanbanColumnContent>
          </KanbanColumn>)}
        </KanbanBoard>
        <KanbanOverlay className="rounded-lg border-2 border-dashed bg-muted/30" />
      </Kanban>
    </div>
  </section>
}
