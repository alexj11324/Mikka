'use client'

import { useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { getIssuePropertyOptions } from '@/app/actions/issue-metadata'
import { createLinkedIssue } from '@/app/actions/issue-operations'
import type { IssueView } from '@/app/actions/issues'
import { TaskAttachments } from './task-attachments'
import type { TaskActivityItem, TaskDetailFrameProps, TaskDetailRow, TaskMenuItem, TaskSubtask } from '@/components/slots/task-detail-contract'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import { useIssueTeam } from '@/components/teams/issue-team-control'
import { formatDateOnly } from '@/lib/date-only'
import type { ExplicitTeamChoice } from '@/lib/issue-team-intent'
import { isIssueListKey } from '@/lib/live/list-read'
import { issueKeys } from '@/lib/swr/keys'
import { useActionError } from '@/lib/use-action-error'
import type { IssueDetailNavigation } from './issue-detail-header'
import { useIssueDetailMenu, type IssueActionRequest } from './issue-detail-actions'
import { overdue } from './issue-detail-properties'
import { AccessChangeDialog, IssueMetadataControls, useIssueMetadataSave, type MetadataRequest } from './issue-metadata-controls'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'
import { useIssueConnections, type RelationKind } from './issue-relations'
import { useIssueScope } from './issue-scope-control'
import { AgentSphere } from './issue-assignee-menu'
import { useIssueThreads, type useAgentActivity } from './issue-threads'
import { useSelectedTaskPresentation } from '@/hooks/use-selected-task-presentation'
import { useActivityEvents } from './issue-activity-feed'
import { useActivityDrafts } from './issue-activity'
import type { IssueDiscussions } from './issue-editor'
import { chronologicalActivity, taskDiscussionEvents } from '@/lib/task-activity-timeline'
import type { ActivityVersion } from '@/lib/issue-activity'
import { PullRequestStatus } from './issue-pull-request-link'

type Issue = IssueView

/** What TaskForm hands over when a layer draws the page (components/workspace/task-detail.tsx). */
export type FramedTaskProps = {
  Frame: ComponentType<TaskDetailFrameProps>
  rootRef: RefObject<HTMLDivElement | null>
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  label: string
  preview: boolean
  locked: boolean
  origin: string
  navigation: IssueDetailNavigation
  onClose: () => void
  onOpen: (id: string) => void
  onDeleted: () => void
  userId: string
  task: Issue
  title: string
  status: string
  priority: string
  liveWorkspaceId: string | null
  saveLabel: string
  saved: boolean
  titleField: TaskDetailFrameProps['titleField']
  saveError: TaskDetailFrameProps['saveError']
  syncNotice: string | null
  /** The description editor with what goes under it, and 活动 drawn by `renderActivity`. */
  editor: (afterDescription: ReactNode, renderActivity: (discussions: IssueDiscussions) => ReactNode) => ReactNode
  acceptance: ReactNode
  versions: ActivityVersion[]
  historyFailed: (() => void) | null
  agentActivity: ReturnType<typeof useAgentActivity>
  documentTools: boolean
  actionRequest: IssueActionRequest | null
  propertyRequest: MetadataRequest | null
  requestAction: (kind: IssueActionRequest['kind']) => void
  requestProperty: (target: MetadataRequest['target']) => void
  getCurrent: () => Promise<Issue | null>
  adopt: (issue: Issue) => void
  onMetadataBusy: (busy: boolean) => void
  onStatus: (value: string) => void
  onPriority: (value: string) => void
  onHistory: () => void
  onMembers: () => void
  onDocumentTools: () => void
  panel: ReactNode | null
  wide: boolean
  resize: TaskDetailFrameProps['resize']
  dialogs: ReactNode
}

const REOPENED = 'todo'

/**
 * A task's page drawn by a layer (task-detail slot): every value, choice and save of the community page, as data
 * and actions. The layer draws them with its own controls; the editor, 验收, an open thread and the dialogs stay Mikka's.
 */
export function FramedTask(props: FramedTaskProps) {
  const { Frame, task, preview, locked, userId, onOpen, getCurrent, adopt } = props
  const t = useTranslations('IssueDetail')
  const tCommon = useTranslations('Common')
  const tFrame = useTranslations('IssueDetail.frame')
  const tDetail = useTranslations('Workspace.detail')
  const tActivity = useTranslations('Workspace.activity')
  const tIssue = useTranslations('Issue')
  const tMenu = useTranslations('IssueDetail.menu')
  const tRelations = useTranslations('Metadata.relations')
  const tProperty = useTranslations('Metadata.property')
  const tAssignee = useTranslations('Metadata.assignee')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value

  const menu = useIssueDetailMenu({ task, userId, disabled: locked, documentTools: props.documentTools, request: props.actionRequest, getCurrent, onSaved: adopt, onOpen, onDeleted: props.onDeleted, onHistory: props.onHistory, onMembers: props.onMembers, onDocumentTools: props.onDocumentTools, onProperty: props.requestProperty, onStatus: props.onStatus, onPriority: props.onPriority })

  // The property choices are read when a menu opens, as the community page reads them when its popover opens.
  const [wantOptions, setWantOptions] = useState(false)
  const { data: options, error: optionsError, mutate: reloadOptions } = useSWR(wantOptions && !locked ? ['issue-property-options', task.id] : null, () => getIssuePropertyOptions(task.id))
  const loadOptions = () => setWantOptions(true)
  const metadata = useIssueMetadataSave({ task, disabled: locked, onSaved: adopt, onBusyChange: props.onMetadataBusy })
  const [teamChoice, setTeamChoice] = useState<ExplicitTeamChoice | null>(null)
  const scope = useIssueScope({ task, disabled: locked, onSaved: adopt, teamChoice })
  const team = useIssueTeam({ issueId: task.id, viewerId: userId, disabled: locked, onChosen: (issueId, teamId) => setTeamChoice(teamId ? { issueId, teamId, selectionId: crypto.randomUUID() } : null) })
  const presentation = useSelectedTaskPresentation(userId, task.workspaceId, preview ? undefined : task.id)
  const { data: threads } = useIssueThreads(task.id, !preview)
  const connections = useIssueConnections({ liveWorkspaceId: props.liveWorkspaceId, viewerId: userId, task, getCurrent, onSaved: adopt, disabled: locked, enabled: !preview })

  const loading = (text = tCommon('loading')): TaskMenuItem[] => optionsError
    ? [{ id: 'reload', label: tCommon('retry'), onSelect: () => { void reloadOptions() } }]
    : [{ id: 'loading', label: text }]
  const busy = locked || metadata.pending
  const meta = task.metadata

  // 负责人 is a person; a Bot the task is handed to has its own line under it (R-60).
  const member = meta.assignee?.kind === 'member' ? meta.assignee : null
  const assigneeItems: TaskMenuItem[] = [
    { id: 'none', label: tAssignee('unassigned'), mark: { kind: 'icon', icon: 'person' }, checked: !member, onSelect: () => { if (member) void metadata.persist({ assignee: null }) } },
    ...options ? options.members.map(person => ({ id: person.id, label: person.name, mark: { kind: 'person', name: person.name } as const, checked: member?.id === person.id, onSelect: () => { if (member?.id !== person.id) void metadata.persist({ assignee: { kind: 'member', id: person.id } }) } })) : loading(tAssignee('loading')),
    ...options?.isOwner ? [{ id: 'invite', label: tAssignee('invite'), mark: { kind: 'icon', icon: 'mail' }, divider: true, onSelect: () => props.requestProperty('invite') } satisfies TaskMenuItem] : [],
  ]
  const agent = meta.delegate
  const delegateThread = (agent ? threads?.find(item => item.detail?.agentName === agent.name) : threads?.find(item => item.detail?.bot))?.detail
  const delegate = agent?.name ?? delegateThread?.agentName

  const allLabels = [...new Map([...(options?.labels ?? []), ...meta.labels].map(label => [label.name, label])).values()]
  const labelItems: TaskMenuItem[] = [
    ...options ? allLabels.map(label => {
      const on = meta.labels.some(item => item.name === label.name)
      return { id: label.name, label: label.name, mark: { kind: 'icon', icon: 'tag' } as const, checked: on, onSelect: () => { void metadata.persist({ labels: on ? meta.labels.filter(item => item.name !== label.name) : [...meta.labels, label] }) } }
    }) : loading(),
    ...options && !allLabels.length ? [{ id: 'empty', label: tProperty('noLabelsYet') }] : [],
    { id: 'create', label: `${tProperty('createLabel')}…`, mark: { kind: 'icon', icon: 'plus' }, divider: true, onSelect: () => props.requestProperty('labels') },
  ]
  const projectItems: TaskMenuItem[] = [
    { id: 'none', label: tProperty('noProject'), mark: { kind: 'icon', icon: 'project' }, checked: !meta.project, onSelect: () => { if (meta.project) void metadata.project(null, options?.projectRecords) } },
    ...options ? options.projects.map(name => ({ id: name, label: name, mark: { kind: 'icon', icon: 'project' } as const, checked: meta.project === name, onSelect: () => { if (meta.project !== name) void metadata.project(name, options.projectRecords) } })) : loading(),
  ]

  const rows: TaskDetailRow[] = [
    {
      id: 'status', label: tIssue('statusLabel'), disabled: locked,
      value: { text: statusLabel(props.status), mark: { kind: 'status', value: props.status } },
      state: presentation.data ?? undefined,
      menu: [
        ...presentation.error ? [{ id: 'reload', label: tAssignee('reload'), onSelect: presentation.retry }] : [],
        ...ISSUE_STATUSES.map(item => ({
          id: item.value, label: statusLabel(item.value), mark: { kind: 'status' as const, value: item.value },
          checked: item.value === props.status, onSelect: () => props.onStatus(item.value),
        })),
      ],
    },
    { id: 'priority', label: tIssue('priorityLabel'), disabled: locked, value: { text: priorityLabel(props.priority), mark: { kind: 'priority', value: props.priority } }, menu: ISSUE_PRIORITIES.map(item => ({ id: item.value, label: priorityLabel(item.value), mark: { kind: 'priority', value: item.value }, checked: item.value === props.priority, onSelect: () => props.onPriority(item.value) })) },
    { id: 'scope', label: scope.judgedByAgent.label, disabled: locked || scope.pending, value: { text: scope.current, mark: { kind: 'icon', icon: task.scope === 'workspace' ? 'workspace' : 'personal' } }, note: scope.judgedByAgent.shown ? scope.judgedByAgent.text : undefined, menu: scope.options.map(option => ({ id: option.value, label: option.label, mark: { kind: 'icon', icon: option.value === 'workspace' ? 'workspace' : 'personal' }, checked: option.value === task.scope, onSelect: () => { void scope.change(option.value) } })) },
    { id: 'assignee', label: tProperty('assignee'), disabled: busy, onOpen: loadOptions, value: member ? { text: member.name, mark: { kind: 'person', name: member.name }, aria: tAssignee('aria', { name: member.name }) } : { text: tAssignee('unassignedLabel'), mark: { kind: 'icon', icon: 'person' }, muted: true, aria: tAssignee('aria', { name: tAssignee('unassigned') }) }, menu: assigneeItems },
    ...delegate ? [{ id: 'delegate', label: tFrame('delegate'), value: { text: delegate, aria: tAssignee('delegatedTo', { name: delegate }), mark: { kind: 'node', node: delegateThread ? <BotAvatar {...(delegateThread.bot ?? COORDINATOR_AVATAR)} size="row" still /> : <AgentSphere name={delegate} compact /> } } } satisfies TaskDetailRow] : [],
    { id: 'labels', label: tProperty('labels'), disabled: busy, onOpen: loadOptions, chips: meta.labels.map(label => ({ id: label.name, text: label.name, title: label.name })), add: { label: tProperty('editLabels'), menu: labelItems } },
    { id: 'project', label: tProperty('project'), disabled: busy, onOpen: loadOptions, value: { text: meta.project ?? tProperty('addToProject'), mark: { kind: 'icon', icon: 'project' }, muted: !meta.project, title: meta.project ?? undefined, aria: tProperty('projectAria', { name: meta.project ?? tProperty('unset') }) }, menu: projectItems },
    { id: 'team', label: team.label, disabled: locked || team.unavailable, value: { text: team.currentLabel, mark: { kind: 'icon', icon: 'team' }, muted: !team.selected, title: team.currentLabel }, menu: team.choices.map(choice => ({ id: choice.value, label: choice.label, mark: { kind: 'icon', icon: 'team' }, checked: choice.value === (team.selected || 'none'), onSelect: () => {
      const value = choice.value === 'none' ? '' : choice.value
      // On reopening a personal task, the stored team still needs an explicit
      // successful selection before it can be used as the sharing destination.
      if (value === (team.data ?? '') && (!value || task.scope !== 'personal' || teamChoice?.teamId === value)) return
      setTeamChoice(null)
      void team.save(value)
    } })) },
    ...meta.dueDate ? [{ id: 'dueDate', label: tProperty('dueDate'), disabled: locked, onClick: () => props.requestAction('dueDate'), value: { text: formatDateOnly(format, meta.dueDate, { month: 'short', day: 'numeric' }), mark: { kind: 'icon', icon: 'calendar' }, danger: overdue(meta.dueDate, props.status, now) } } satisfies TaskDetailRow] : [],
    ...meta.estimate !== null ? [{ id: 'estimate', label: tProperty('estimate'), disabled: locked, onClick: () => props.requestAction('estimate'), value: { text: tProperty('estimatePoints', { count: meta.estimate }), mark: { kind: 'icon', icon: 'estimate' } } } satisfies TaskDetailRow] : [],
    ...meta.pullRequests.length ? [{ id: 'pullRequests', label: tProperty('pullRequests'), disabled: locked, chips: meta.pullRequests.map(pr => ({ id: pr.url, text: `#${pr.url.split('/').filter(Boolean).at(-1)}`, href: pr.url, mark: { kind: 'icon', icon: 'pullRequest' }, live: draw => <PullRequestStatus issueId={task.id} pr={pr}>{view => draw({ text: view.text ? `#${view.number} ${view.text}` : `#${view.number}`, title: view.title, state: view.state, confirmed: view.confirmed })}</PullRequestStatus> })), add: { label: tProperty('managePullRequestsAria'), onClick: () => props.requestProperty('pullRequests') } } satisfies TaskDetailRow] : [],
    ...preview ? [] : connections.groups.filter(group => group.items.length).map((group): TaskDetailRow => ({
      id: `relation-${group.kind}`, label: group.label, disabled: locked || connections.pending,
      chips: group.items.map(row => ({
        id: row.id, text: [row.identifier, row.title].filter(Boolean).join(' '), title: row.title,
        mark: { kind: 'icon', icon: group.kind === 'parent' ? 'parent' : group.kind === 'blockedBy' || group.kind === 'blocks' ? 'flag' : 'link' },
        menu: [
          { id: 'open', label: tFrame('open'), mark: { kind: 'icon', icon: 'open' }, onSelect: () => onOpen(row.id) },
          { id: 'remove', label: tRelations('removeAria', { label: group.label, title: row.title }), mark: { kind: 'icon', icon: 'remove' }, danger: true, onSelect: () => { void connections.remove(relationOf(group.kind, row, connections.current, task.id), row.id) } },
        ],
      })),
    })),
  ]

  // 子任务: ticking one sets it done, unticking puts it back to 待办; its menu holds every status and removing it.
  const subtasks: TaskSubtask[] = connections.children.map(row => {
    const done = connections.closed(row.status)
    return {
      id: row.id, identifier: row.identifier, title: row.title, done, statusLabel: statusLabel(row.status),
      onToggle: () => { void connections.status(row.id, row.revision, done ? REOPENED : 'done') },
      onOpen: () => onOpen(row.id),
      menu: [
        ...connections.statusOptions.map(item => ({ id: item.value, label: item.label, mark: { kind: 'status', value: item.value } as const, checked: item.value === row.status, onSelect: () => { void connections.status(row.id, row.revision, item.value) } })),
        { id: 'remove', label: tRelations('removeChildAria', { title: row.title }), mark: { kind: 'icon', icon: 'remove' }, danger: true, divider: true, onSelect: () => { void connections.remove('child', row.id) } },
      ],
    }
  })
  const creating = useRef(false)
  // The same create as 创建子任务… in the ⋯ menu (IssueDetailActions), with the title typed in the line.
  async function createChild(title: string) {
    if (creating.current || locked || !title.trim()) return false
    creating.current = true
    try {
      const latest = await getCurrent()
      if (!latest) throw new Error(t('saveCurrentFirst'))
      const result: { issue?: Issue; error?: string } = await createLinkedIssue({ id: task.id, revision: latest.revision, kind: 'child', title: title.trim(), includeSubissues: false })
      if (!result.issue) throw new Error(actionError(result.error ?? 'generic'))
      await Promise.all([mutate(issueKeys.connections(task.id)), mutate(key => isIssueListKey(key, userId))])
      toast.success(t('childCreated'))
      return true
    } catch (error) { toast.error(error instanceof Error ? error.message : t('operationFailed')); return false }
    finally { creating.current = false }
  }

  // 活动: the task's events, its Agent rows and its discussions in one log, oldest first.
  const subtaskRows = (connections.rows ?? []).filter(row => row.metadata.parentId === task.id).map(row => ({ id: row.id, title: row.title, createdAt: row.createdAt }))
  const eventsFor = useActivityEvents(props.historyFailed ? [] : props.versions, props.historyFailed ? [] : subtaskRows)
  const discussions = useRef<IssueDiscussions | null>(null)
  const drafts = useActivityDrafts(task.id, body => discussions.current?.onComment(body), (id, body) => discussions.current?.onReply(id, body))
  const time = (at: string) => format.dateTime(new Date(at), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const activityItems = (current: IssueDiscussions, expandReplies = false, additional: readonly TaskActivityItem[] = []): TaskActivityItem[] => {
    const anchors = new Map(current.anchors.map(anchor => [anchor.id, anchor.excerpt]))
    const byId = new Map(current.threads.map(thread => [thread.id, thread]))
    const excerpt = (id: string) => id.startsWith('discussion-') ? null : anchors.get(id) ?? tActivity('anchorRemoved')
    const comments: TaskActivityItem[] = expandReplies
      ? taskDiscussionEvents(current.threads).map(fact => {
        const thread = byId.get(fact.threadId)!
        return { kind: 'comment', id: fact.id, at: fact.at, thread, time, excerpt: excerpt(thread.id),
          message: { record: { id: fact.messageId, body: fact.body, author: fact.author, at: fact.at }, first: fact.kind === 'comment', last: fact.messageId === thread.messages.at(-1)?.id } }
      })
      : current.threads.map(thread => ({ kind: 'comment', id: thread.id, at: thread.createdAt, thread, time, excerpt: excerpt(thread.id) }))
    const history = eventsFor([...props.agentActivity.items, ...comments, ...additional])
    return chronologicalActivity<TaskActivityItem>([
      ...history.map((item): TaskActivityItem => ({ kind: 'event', id: `history:${item.id}`, at: item.at, who: item.actor?.name ?? null, mark: item.actor?.name ? (item.actor.type === 'agent' ? { kind: 'node', node: <AgentSphere name={item.actor.name} compact /> } : { kind: 'person', name: item.actor.name }) : undefined, text: item.text, time: item.time })),
      ...props.agentActivity.items.map((item): TaskActivityItem => ({ kind: 'agent', id: item.id, at: item.at, who: item.name, mark: { kind: 'node', node: item.mark }, text: item.result, time: item.time, open: item.open, onOpen: item.onOpen, openLabel: tFrame('openThread', { name: item.name }) })),
      ...comments, ...additional,
    ])
  }

  const created = new Date(task.createdAt)
  return <Frame
    taskId={preview ? undefined : task.id}
    attachments={preview ? undefined : trigger => <TaskAttachments key={task.id} taskId={task.id} trigger={trigger} />}
    workspaceId={preview ? undefined : task.workspaceId}
    factoryTaskId={presentation.data?.factoryTaskId}
    rootRef={props.rootRef} onKeyDown={props.onKeyDown} label={props.label} busy={preview}
    origin={props.origin} identifier={task.identifier} title={props.title} saveLabel={props.saveLabel} saved={props.saved} saveHint={t('autosaveHint')}
    navigation={props.navigation} onClose={props.onClose}
    words={{
      previous: t('previousTask'), next: t('nextTask'), close: tDetail('closeDetail'), more: tDetail('moreActions'), details: t('propertiesHeading'),
      subtasks: tRelations('subissues'), subtaskPlaceholder: tFrame('subtaskPlaceholder'), addSubtask: tRelations('addChild'), subtaskMenu: title => tFrame('subtaskMenu', { title }),
      activity: tActivity('title'), comment: tActivity('commentLabel'), commentPlaceholder: tActivity('commentPlaceholder'), send: tActivity('sendComment'),
      reply: tActivity('replyLabel'), replyPlaceholder: tActivity('replyPlaceholder'), sendReply: tActivity('sendReply'), resolve: tActivity('resolve'), reopen: tActivity('reopen'), resolved: tActivity('resolved'),
      anchorRemoved: tActivity('anchorRemoved'), copyLink: tMenu('copyLink'), commentBy: name => tActivity('comment', { author: name }),
    }}
    favorite={menu.favorite}
    menu={{ items: menu.items.map(item => item.id === 'assignee' ? { ...item, onSelect: undefined, submenu: assigneeItems } : item.id === 'project' ? { ...item, onSelect: undefined, submenu: projectItems } : item.id === 'labels' ? { ...item, onSelect: undefined, submenu: labelItems } : item), disabled: menu.disabled, onOpen: loadOptions }}
    titleField={props.titleField} saveError={props.saveError} syncNotice={props.syncNotice}
    description={({ afterDescription, activity }) => props.editor(afterDescription, current => { discussions.current = current; return activity(current) })}
    acceptance={props.acceptance}
    copyLink={menu.copyLink}
    subtasks={preview ? null : { items: subtasks, done: subtasks.filter(item => item.done).length, total: subtasks.length, onCreate: createChild, disabled: locked || connections.pending, failed: connections.error ? { text: tRelations('readFailedRetry'), retry: () => { void connections.mutate() } } : null }}
    activity={preview ? null : {
      items: activityItems, timeline: (current, additional) => activityItems(current, true, additional),
      failed: [...props.historyFailed ? [{ text: tDetail('activityFailed'), retry: props.historyFailed }] : [], ...props.agentActivity.failed ? [{ text: props.agentActivity.failed.label, retry: props.agentActivity.failed.retry }] : []],
      drafts, subscribed: menu.subscribed, onSubscribe: menu.toggleSubscribed, subscribeLabel: menu.subscribed ? tFrame('unsubscribe') : tFrame('subscribe'),
    }}
    rows={rows}
    rowsError={metadata.error || team.failed || (presentation.error ? actionError() : '')}
    meta={[task.identifier, tFrame('created', { when: format.relativeTime(created, now) })].filter(Boolean).join(' · ')}
    panel={props.panel} wide={props.wide} resize={props.resize}
    dialogs={<>{props.dialogs}{menu.dialogs}<AccessChangeDialog change={metadata.accessChange} pending={metadata.pending} onConfirm={metadata.confirmAccess} onCancel={metadata.cancelAccessChange} /><IssueMetadataControls task={task} section="dialog" disabled={locked} onSaved={adopt} onBusyChange={props.onMetadataBusy} request={props.propertyRequest} /></>}
  />
}

/** Which relation a 相关 row really is: a closed block shows as related but is removed as the block it is. */
function relationOf(kind: RelationKind, row: { id: string; metadata: { blockedByIds: string[] } }, current: { blockedByIds: string[] }, taskId: string): RelationKind {
  if (kind !== 'related') return kind
  if (current.blockedByIds.includes(row.id)) return 'blockedBy'
  if (row.metadata.blockedByIds.includes(taskId)) return 'blocks'
  return kind
}
