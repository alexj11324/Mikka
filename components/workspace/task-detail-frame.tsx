'use client'

import { githubPullRequestKey, taskWorkOwner } from '@/lib/issue-metadata'

import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import useSWR from 'swr'
import { useFormatter, useMessages, useNow, useTranslations } from '@/lib/intl/i18n-client'
import { getIssuePropertyOptions } from '@/app/actions/issue-metadata'
import type { IssueView } from '@/app/actions/issues'
import { TaskAttachments } from './task-attachments'
import type { TaskActivityGlyph, TaskActivityItem, TaskDetailFrameProps, TaskDetailRow, TaskMenuItem, TaskSubtask } from '@/components/slots/task-detail-contract'
import { useIssueTeam, type TaskTeamSnapshot } from '@/components/teams/issue-team-control'
import { formatDateOnly } from '@/lib/date-only'
import { withBasePath } from '@/lib/base-path'
import { taskProjectOptions } from '@/lib/task-project-options'
import { useActionError } from '@/lib/use-action-error'
import type { IssueDetailNavigation } from './issue-detail-header'
import { useIssueDetailMenu, type IssueActionRequest } from './issue-detail-actions'
import { overdue } from './issue-detail-properties'
import { AccessChangeDialog, IssueMetadataControls, useIssueMetadataSave, type MetadataRequest } from './issue-metadata-controls'
import { ISSUE_PRIORITIES } from './issue-properties'
import { issueStateMenuItems } from './issue-state-menu'
import { Mark } from './state-mark'
import { useIssueStates } from '@/hooks/use-issue-states'
import { useTaskUnread } from '@/hooks/use-task-unread'
import { issueStateLabel, taskIssueState } from '@/lib/issue-states'
import { useIssueConnections, type RelationKind } from './issue-relations'
import { useTaskOwnershipRows } from './issue-scope-control'
import { AgentSphere } from './issue-assignee-menu'
import type { useTaskWork } from './issue-threads'
import { openGroupConversation } from './workspace-navigation'
import { useActivityEvents, type ActivityEventItem } from './issue-activity-feed'
import { useActivityDrafts, type DiscussionSave } from './issue-activity'
import { isThreadRun, threadQuestionView } from '@/lib/issue-threads'
import { presentedFactoryEvents, taskFactoryProgress } from '@/lib/task-factory-events'
import { runResult, useRunResultLabel } from '@/hooks/use-run-result'
import { pullLabel } from '@/lib/issue-activity'
import { ThreadStatusIcon } from './thread-status-icon'
import type { IssueDiscussions } from './issue-editor'
import { chronologicalActivity, pullRequestActivityEvents, taskActivityThreads, taskDiscussionEvents, type PullRequestActivitySource } from '@/lib/task-activity-timeline'
import type { ActivityVersion } from '@/lib/issue-activity'
import { PullRequestStatus } from './issue-pull-request-link'

// Start work's window loads when it opens: its pickers read devices, Bots and profiles the task page does not need.
const StartWorkDialog = lazy(() => import('@/components/coordinator/start-work-dialog').then(module => ({ default: module.StartWorkDialog })))

type Issue = IssueView

type PullRequestStatusPayload = {
  viewerId: string
  url: string
  state: 'open' | 'closed' | 'merged'
  title: string | null
  createdAt: string | null
  mergedAt: string | null
}

function isPullRequestStatusPayload(value: unknown): value is PullRequestStatusPayload {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.viewerId === 'string' && typeof item.url === 'string'
    && (item.state === 'open' || item.state === 'closed' || item.state === 'merged')
    && (item.title === null || typeof item.title === 'string')
    && (item.createdAt === null || typeof item.createdAt === 'string')
    && (item.mergedAt === null || typeof item.mergedAt === 'string')
}

async function pullRequestTimelineFetcher(key: readonly [string, string, string, string]) {
  const [, viewerId, issueId, serializedUrls] = key
  const urls: unknown = JSON.parse(serializedUrls)
  if (!Array.isArray(urls) || !urls.every(url => typeof url === 'string')) return { items: [] as PullRequestActivitySource[], failed: true }
  const results = await Promise.all(urls.map(async url => {
    try {
      const response = await fetch(withBasePath('/api/github/pull-request-status'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ issueId, url }),
      })
      if (!response.ok) return null
      const value: unknown = await response.json()
      if (!isPullRequestStatusPayload(value) || value.viewerId !== viewerId || value.url.replace(/\/$/, '').toLowerCase() !== url.replace(/\/$/, '').toLowerCase()) return null
      return { url: value.url, title: value.title, state: value.state, createdAt: value.createdAt, mergedAt: value.mergedAt } satisfies PullRequestActivitySource
    } catch { return null }
  }))
  return { items: results.filter((item): item is PullRequestActivitySource => item !== null), failed: results.some(item => item === null) }
}

/** Data and commands the shared Task controller supplies to the official renderer. */
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
  /** The workspace state the task is in (lib/issue-states.ts); null before it is known. */
  stateId?: string | null
  priority: string
  liveWorkspaceId: string | null
  saveLabel: string
  saved: boolean
  titleField: TaskDetailFrameProps['titleField']
  saveError: TaskDetailFrameProps['saveError']
  syncNotice: string | null
  discussionSave?: DiscussionSave
  /** The description editor with what goes under it, and 活动 drawn by `renderActivity`. */
  descriptionEditable?: boolean
  editor: (afterDescription: ReactNode, renderActivity: (discussions: IssueDiscussions) => ReactNode) => ReactNode
  acceptance: ReactNode
  artifacts?: ReactNode
  versions: ActivityVersion[]
  activityPredecessor?: ActivityVersion | null
  historyFailed: (() => void) | null
  earlierActivity: { hasMore: boolean; loading: boolean; failed: boolean; load: () => void }
  teamSnapshot?: TaskTeamSnapshot
  agentActivity: ReturnType<typeof useTaskWork>
  documentTools: boolean
  actionRequest: IssueActionRequest | null
  propertyRequest: MetadataRequest | null
  requestAction: (kind: IssueActionRequest['kind']) => void
  requestProperty: (target: MetadataRequest['target']) => void
  getCurrent: () => Promise<Issue | null>
  adopt: (issue: Issue) => void
  onMetadataBusy: (busy: boolean) => void
  /** `stateId`: the workspace state picked; absent from a writer that only knows the category. */
  onStatus: (value: string, stateId?: string | null) => void
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

export function FramedTask(props: FramedTaskProps) {
  const { Frame, task, preview, locked, userId, onOpen, getCurrent, adopt } = props
  const t = useTranslations('IssueDetail')
  const tCommon = useTranslations('Common')
  const tFrame = useTranslations('IssueDetail.frame')
  const tNewTask = useTranslations('Shell.newTaskDialog')
  const [startingWork, setStartingWork] = useState(false)
  const tDetail = useTranslations('Workspace.detail')
  const tDirectory = useTranslations('ConversationDirectory')
  const tThreads = useTranslations('IssueThreads')
  const resultLabel = useRunResultLabel()
  const messages = useMessages()
  const labelStage = (stage: string) => (messages.GroupTask.stage as Record<string, string>)[stage] ?? stage
  const labelGate = (status: string) => (messages.GroupTask.status as Record<string, string>)[status] ?? status
  const tArtifact = useTranslations('ArtifactReview')
  const tActivity = useTranslations('Workspace.activity')
  const tIssue = useTranslations('Issue')
  const tMenu = useTranslations('IssueDetail.menu')
  const tRelations = useTranslations('Metadata.relations')
  const tProperty = useTranslations('Metadata.property')
  const tAssignee = useTranslations('Metadata.assignee')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const actionError = useActionError()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value

  // The task page owns the states' live subscription; the menus below read the same entry (decision 2026-11-19-2115).
  const issueStates = useIssueStates(task.workspaceId, { live: true }).states
  // Opening a task the person marked unread marks it read again (Mark as unread, S1-C).
  const taskUnread = useTaskUnread(task.workspaceId)
  const markRead = taskUnread.unread.has(task.id) ? taskUnread.set : null
  useEffect(() => { if (markRead) void markRead(task.id, false) }, [markRead, task.id])
  const stateItems = issueStateMenuItems(issueStates, { status: props.status, stateId: props.stateId }, statusLabel, props.onStatus)
  const currentState = issueStates ? taskIssueState(issueStates, { status: props.status, stateId: props.stateId }) : undefined
  const menu = useIssueDetailMenu({ task, userId, disabled: locked, documentTools: props.documentTools, request: props.actionRequest, getCurrent, onSaved: adopt, onOpen, onDeleted: props.onDeleted, onHistory: props.onHistory, onMembers: props.onMembers, onDocumentTools: props.onDocumentTools, onProperty: props.requestProperty, onStatus: props.onStatus, onPriority: props.onPriority, statusItems: stateItems })

  // The property choices are read when a menu opens, as the community page reads them when its popover opens.
  const [wantOptions, setWantOptions] = useState(false)
  const { data: options, error: optionsError, mutate: reloadOptions } = useSWR(wantOptions && !locked ? ['issue-property-options', task.id] : null, () => getIssuePropertyOptions(task.id))
  const loadOptions = () => setWantOptions(true)
  const metadata = useIssueMetadataSave({ task, disabled: locked, onSaved: adopt, onBusyChange: props.onMetadataBusy })
  const ownershipRows = useTaskOwnershipRows(task, userId, preview, locked, adopt)
  const team = useIssueTeam({ issueId: task.id, viewerId: userId, disabled: locked }, props.teamSnapshot, !preview)
  const presentation = { data: props.agentActivity.work?.presentation, error: props.agentActivity.failed, retry: props.agentActivity.retry }

  const connections = useIssueConnections({ snapshot: props.agentActivity.connections, liveWorkspaceId: props.liveWorkspaceId, viewerId: userId, task, getCurrent, onSaved: adopt, disabled: locked, enabled: !preview })

  const loading = (text = tCommon('loading')): TaskMenuItem[] => optionsError
    ? [{ id: 'reload', label: tCommon('retry'), onSelect: () => { void reloadOptions() } }]
    : [{ id: 'loading', label: text }]
  const busy = locked || metadata.pending
  const meta = task.metadata
  const pullRequests = presentation.data?.pullRequests ?? meta.pullRequests
  const pullRequestUrls = pullRequests.map(pr => pr.url)
  const pullRequestTimeline = useSWR(
    !preview && pullRequestUrls.length ? ['issue-pull-request-timeline', userId, task.id, JSON.stringify(pullRequestUrls)] as const : null,
    pullRequestTimelineFetcher,
  )

  // The human assignment picker and the execution delegate keep their independent write authority.
  const workOwner = taskWorkOwner(meta)
  const member = meta.assignee?.kind === 'member' ? meta.assignee : null
  const ownerWithoutMember = member ? meta.delegate : workOwner
  const assigneeItems: TaskMenuItem[] = [
    {
      id: 'none', label: ownerWithoutMember?.name ?? tAssignee('unassigned'),
      mark: ownerWithoutMember ? { kind: 'node', node: <AgentSphere name={ownerWithoutMember.name} compact /> } : { kind: 'icon', icon: 'person' },
      checked: !member, onSelect: member ? () => { void metadata.persist({ assignee: null }) } : undefined,
    },
    ...options ? options.members.map(person => ({ id: person.id, label: person.name, mark: { kind: 'person', name: person.name } as const, checked: member?.id === person.id, onSelect: () => { if (member?.id !== person.id) void metadata.persist({ assignee: { kind: 'member', id: person.id } }) } })) : loading(tAssignee('loading')),
    ...options?.isOwner ? [{ id: 'invite', label: tAssignee('invite'), mark: { kind: 'icon', icon: 'mail' }, divider: true, onSelect: () => props.requestProperty('invite') } satisfies TaskMenuItem] : [],
  ]
  const delegate = meta.delegate?.name
  // Capy's Thread lines: each conversation with where it is. A Factory conversation says its stage (实现中, 交给你…);
  // any other its run result. The steps themselves are in the conversation, not on the task page.
  const factoryEvents = props.agentActivity.work?.factory
  const stageOf = new Map(taskFactoryProgress(presentedFactoryEvents(factoryEvents?.events, factoryEvents?.task.id))
    .flatMap(group => group.runId ? [[group.runId, group.current] as const] : []))
  const conversations = [
    ...(presentation.data?.linkedChats ?? []).map(chat => ({
      id: 'chat:' + chat.id, text: chat.title || tDirectory('untitled'), detail: undefined as string | undefined, mark: undefined as ReactNode, open: () => openGroupConversation(chat.id),
    })),
    // Only the task's own conversations: a review or verify runs on its own and is a child conversation inside the one it checks.
    ...(props.agentActivity.threads ?? []).filter(isThreadRun).flatMap(thread => {
      if (!thread.detail) return []
      const view = threadQuestionView(thread)
      const run = { status: view.waiting ? 'waiting_input' : view.status, outcome: view.outcome }
      const { result, reason } = runResult(run, true)
      // The Factory's own gate says the stage and how it stands; without one, the stage the run was dispatched for.
      // A thread read without its chain (an older read) has no attempts: its own id still finds its gate.
      const attempts = thread.attempts ?? []
      const gate = [thread.id, ...attempts.map(attempt => attempt.runId)].map(id => stageOf.get(id)).find(Boolean)
      const stage = attempts.at(-1)?.stage ?? attempts[0]?.stage
      const detail = gate ? [labelStage(gate.stage), labelGate(gate.status)].filter(Boolean).join(' · ')
        : stage ? [labelStage(stage), view.stopping ? tThreads('stopping') : resultLabel(result, reason)].join(' · ')
        : view.stopping ? tThreads('stopping') : resultLabel(result, reason)
      // Capy's thread line leads with the conversation's coloured status mark, done or not.
      return [{ id: 'run:' + thread.id, text: thread.detail.name || tDirectory('untitled'), detail, mark: <ThreadStatusIcon status={view.status} outcome={view.outcome} waiting={view.waiting} small dot={false} /> as ReactNode, open: () => props.agentActivity.openThread(thread.id) }]
    }),
  ]
  const reviewBranch = props.agentActivity.work?.factory?.task.review?.summary?.branch

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
    { id: 'none', label: tProperty('noProject'), mark: { kind: 'icon', icon: 'project' }, checked: !task.projectId && !meta.project, onSelect: () => { if (task.projectId || meta.project) void metadata.project(null) } },
    ...options ? taskProjectOptions(options.projectRecords ?? [], task.projectId).map(item => ({
      ...item, mark: { kind: 'icon', icon: 'project' } as const,
      onSelect: () => { if (!item.checked) void metadata.project(item.id) },
    })) : loading(),
  ]

  const creator = props.versions.find(version => version.revision === 1)?.actor?.name ?? null
  const rows: TaskDetailRow[] = [
    {
      id: 'status', label: tIssue('statusLabel'), disabled: locked,
      value: currentState
        ? { text: issueStateLabel(currentState, statusLabel), mark: { kind: 'node', node: <Mark shape={currentState.icon} tone={currentState.color} /> } }
        : { text: statusLabel(props.status), mark: { kind: 'status', value: props.status } },
      state: presentation.data ?? undefined,
      menu: [
        ...presentation.error ? [{ id: 'reload', label: tAssignee('reload'), onSelect: presentation.retry }] : [],
        ...stateItems,
      ],
    },
    { id: 'priority', label: tIssue('priorityLabel'), disabled: locked, value: { text: priorityLabel(props.priority), mark: { kind: 'priority', value: props.priority } }, menu: ISSUE_PRIORITIES.map(item => ({ id: item.value, label: priorityLabel(item.value), mark: { kind: 'priority', value: item.value }, checked: item.value === props.priority, onSelect: () => props.onPriority(item.value) })) },
    ...ownershipRows,
    { id: 'assignee', label: tProperty('assignee'), disabled: busy, onOpen: loadOptions, value: member ? { text: member.name, mark: { kind: 'person', name: member.name }, aria: tAssignee('aria', { name: member.name }) } : workOwner ? { text: workOwner.name, mark: { kind: 'node', node: <AgentSphere name={workOwner.name} compact /> }, aria: tAssignee('aria', { name: workOwner.name }) } : { text: tAssignee('unassignedLabel'), mark: { kind: 'icon', icon: 'person' }, muted: true, aria: tAssignee('aria', { name: tAssignee('unassigned') }) }, menu: assigneeItems },
    ...member && delegate ? [{ id: 'delegate', label: tFrame('delegate'), value: { text: delegate, aria: tAssignee('delegatedTo', { name: delegate }), mark: { kind: 'node', node: <AgentSphere name={delegate} compact /> } } } satisfies TaskDetailRow] : [],
    { id: 'labels', label: tProperty('labels'), disabled: busy, onOpen: loadOptions, chips: meta.labels.map(label => ({ id: label.name, text: label.name, title: label.name })), add: { label: tProperty('editLabels'), menu: labelItems } },
    { id: 'project', label: tProperty('project'), disabled: busy, onOpen: loadOptions, value: { text: meta.project ?? tProperty('addToProject'), mark: { kind: 'icon', icon: 'project' }, muted: !meta.project, title: meta.project ?? undefined, aria: tProperty('projectAria', { name: meta.project ?? tProperty('unset') }) }, menu: projectItems },
    { id: 'team', label: team.label, disabled: locked || team.unavailable, value: { text: team.currentLabel, mark: { kind: 'icon', icon: 'team' }, muted: !team.selected, title: team.currentLabel }, menu: team.choices.map(choice => ({ id: choice.value, label: choice.label, mark: { kind: 'icon', icon: 'team' }, checked: choice.value === (team.selected || 'none'), onSelect: () => {
      const value = choice.value === 'none' ? '' : choice.value
      if (value === (team.data ?? '')) return
      void team.save(value)
    } })) },
    // Capy's Created by: whoever made the task's first revision (the same actor 活动 starts with).
    ...creator ? [{ id: 'createdBy', label: tProperty('createdBy'), value: { text: creator, mark: { kind: 'person', name: creator } } } satisfies TaskDetailRow] : [],
    ...meta.dueDate ? [{ id: 'dueDate', label: tProperty('dueDate'), disabled: locked, onClick: () => props.requestAction('dueDate'), value: { text: formatDateOnly(format, meta.dueDate, { month: 'short', day: 'numeric' }), mark: { kind: 'icon', icon: 'calendar' }, danger: overdue(meta.dueDate, props.status, now) } } satisfies TaskDetailRow] : [],
    ...meta.estimate !== null ? [{ id: 'estimate', label: tProperty('estimate'), disabled: locked, onClick: () => props.requestAction('estimate'), value: { text: tProperty('estimatePoints', { count: meta.estimate }), mark: { kind: 'icon', icon: 'estimate' } } } satisfies TaskDetailRow] : [],
    ...conversations.length ? [{ id: 'conversations', label: tProperty(conversations.length > 1 ? 'threadMany' : 'threadOne'), stacked: true,
      chips: conversations.map(({ id, text, detail, mark, open }) => ({ id, text, ...detail ? { detail } : {}, ...mark ? { mark: { kind: 'node' as const, node: mark } } : {}, menu: [{ id: 'open', label: tFrame('open'), onSelect: open }] })),
    } satisfies TaskDetailRow] : [],
    ...reviewBranch ? [{ id: 'branch', label: tArtifact('branch'), value: { text: reviewBranch } } satisfies TaskDetailRow] : [],
    // Capy's Pull requests lines: repo#n and its title, its live state, and + to link one, shown even before there is one.
    ...preview ? [] : [{ id: 'pullRequests', label: tProperty(pullRequests.length > 1 ? 'pullRequestMany' : 'pullRequestOne'), disabled: locked, stacked: true, chips: pullRequests.map(pr => ({ id: pr.url, text: [pullLabel(pr.url), pr.title].filter(Boolean).join(' '), href: pr.url, mark: { kind: 'icon', icon: 'pullRequest' }, ...pr.state ? { state: pr.state } : {}, live: draw => <PullRequestStatus issueId={task.id} pr={pr}>{view => draw({ text: [pullLabel(pr.url), view.text || pr.title].filter(Boolean).join(' '), title: view.title, state: view.state, confirmed: view.confirmed })}</PullRequestStatus> })), add: { label: tProperty('linkPullRequest'), onClick: () => props.requestProperty('pullRequests') } } satisfies TaskDetailRow],
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

  // 活动: the task's events, its Agent rows and its discussions in one log, oldest first.
  const subtaskRows = (connections.rows ?? []).filter(row => row.metadata.parentId === task.id).map(row => ({ id: row.id, title: row.title, identifier: row.identifier, createdAt: row.createdAt }))
  // A recorded source run can name an Agent's conversation; actor and time alone do not establish it.
  const runConversations = (props.agentActivity.threads ?? []).map(thread => ({
    at: new Date(thread.createdAt).toISOString(), runId: thread.id, agentId: thread.detail?.agentId ?? null, linked: Boolean(thread.detail),
    title: thread.detail?.name || tDirectory('untitled'), ...thread.detail?.harness ? { harness: thread.detail.harness } : {},
  }))
  const eventsFor = useActivityEvents(props.historyFailed ? [] : props.versions, props.historyFailed ? [] : subtaskRows, {
    predecessor: props.historyFailed ? null : props.activityPredecessor,
    task: {
      taskId: task.id, code: task.identifier, title: props.title, status: props.status, priority: props.priority, assignee: member?.name,
      // Parent, sub-tasks and related tasks this page already reads, so a sentence names them by code, as Capy's does.
      refs: Object.fromEntries((connections.rows ?? []).map(row => [row.id, { code: row.identifier ?? null, title: row.title, status: row.status, ...row.priority ? { priority: row.priority } : {} }])),
    },
    stretches: runConversations,
  })
  const discussions = useRef<IssueDiscussions | null>(null)
  const drafts = useActivityDrafts(task.id,
    (body, operationId) => discussions.current ? discussions.current.onComment(body, operationId) : false,
    (id, body, operationId) => {
      const current = discussions.current
      if (!current) return false
      // A physical discussion may contain more than one stage card. Old renderers still submit its thread ID.
      if (current.threads.some(thread => thread.id === id)) return current.onReply(id, body, operationId)
      const stage = presentation.data?.factoryStageComments?.find(source => `discussion:${source.threadId}:${source.messageId}` === id)
      return stage ? current.onReply(stage.threadId, body, operationId, stage.messageId) : false
    },
    props.discussionSave)
  // Every row says how long ago, as Capy's log does; the date and time is the tooltip. `now` ticks once a minute: a comment sent since reads 「现在」.
  const time = (at: string) => format.relativeTime(new Date(Math.min(Date.parse(at), now.getTime())), now)
  const exact = (at: string) => format.dateTime(new Date(at), { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const pullRequestEvents = pullRequestActivityEvents(pullRequestTimeline.data?.items ?? [], {
    opened: (repo, number, title) => tActivity('timelinePullOpened', { repo, number, title }),
    merged: (repo, number, title) => tActivity('timelinePullMerged', { repo, number, title }),
    time,
  })
  const reportedMerges = new Set(pullRequestEvents.filter(event => event.id.endsWith(':merged')).map(event =>
    githubPullRequestKey(event.id.slice('pull:'.length, -':merged'.length))))
  const activityItems = (current: IssueDiscussions, expandReplies = false, additional: readonly TaskActivityItem[] = []): TaskActivityItem[] => {
    const anchors = new Map(current.anchors.map(anchor => [anchor.id, anchor.excerpt]))
    const groups = taskActivityThreads(current.threads, presentation.data?.factoryStageComments ?? [])
    const comments: TaskActivityItem[] = groups.flatMap((group): TaskActivityItem[] => {
      const { thread } = group
      const excerpt = group.actor || thread.id.startsWith('discussion-') ? null : anchors.get(thread.id) ?? tActivity('anchorRemoved')
      if (!expandReplies) return [{ kind: 'comment', id: group.id, actor: group.actor, at: thread.createdAt, thread, time, exact, excerpt }]
      return taskDiscussionEvents(group).map(fact => ({
        kind: 'comment', id: fact.id, actor: fact.actor, at: fact.at, thread, time, exact, excerpt,
        message: { record: { id: fact.messageId, body: fact.body, author: fact.author, at: fact.at }, first: fact.kind === 'comment', last: fact.messageId === thread.messages.at(-1)?.id },
      }))
    })
    const history = eventsFor([...comments, ...additional]).filter(item =>
      item.pullAction !== 'merged' || !item.pullHref || !reportedMerges.has(githubPullRequestKey(item.pullHref)))
    return chronologicalActivity<TaskActivityItem>([
      ...history.map((item): TaskActivityItem => ({ kind: 'event', id: `history:${item.id}`, at: item.at, who: item.actor?.name || (item.actor?.type === 'system' ? t('work.system') : item.actor?.type === 'agent' ? t('work.agent') : null), mark: item.actor?.name ? (item.actor.type === 'agent' ? { kind: 'node', node: <AgentSphere name={item.actor.name} compact /> } : { kind: 'person', name: item.actor.name }) : undefined, text: item.text, parts: item.parts, time: item.time, exact: item.exact, actor: item.pullAction === 'merged' || !item.actor ? null : item.actor.type === 'agent' ? 'agent' : 'person', glyph: glyphOf(item) })),
      ...comments, ...additional, ...pullRequestEvents,
    ])
  }

  const readerMenu = locked && !preview
  const menuItems = readerMenu
    ? menu.items.filter(item => item.id === 'history')
    : [...menu.items.map(item => item.id === 'assignee' ? { ...item, onSelect: undefined, submenu: assigneeItems } : item.id === 'project' ? { ...item, onSelect: undefined, submenu: projectItems } : item.id === 'labels' ? { ...item, onSelect: undefined, submenu: labelItems } : item),
      // The task page shows the team only once it has one (as Capy shows only set properties): the ⋯ menu sets it.
      ...team.unavailable || team.selected ? [] : [{ id: 'team', label: team.label, mark: { kind: 'icon', icon: 'team' } as const, submenu: rows.find(row => row.id === 'team')?.menu ?? [] } satisfies TaskMenuItem]]
  // Start work: 新建任务 only registers a task, so its work starts here (decision 2026-11-19-2110).
  const startWork = preview || locked ? undefined : { label: tNewTask('startWork'), onStart: () => setStartingWork(true) }
  const startWorkItem: TaskMenuItem[] = startWork ? [{ id: 'startWork', label: startWork.label, mark: { kind: 'icon', icon: 'open' }, onSelect: startWork.onStart }] : []
  const created = new Date(task.createdAt)
  return <Frame
    taskId={preview ? undefined : task.id}
    attachments={preview ? undefined : trigger => <TaskAttachments key={task.id} taskId={task.id} taskCode={task.identifier} trigger={trigger} />}
    workspaceId={preview ? undefined : task.workspaceId}
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
    startWork={startWork}
    menu={{ items: [...startWorkItem, ...menuItems], disabled: !readerMenu && menu.disabled, onOpen: loadOptions }}
    titleField={props.titleField} saveError={props.saveError} syncNotice={props.syncNotice}
    descriptionEditable={props.descriptionEditable}
    description={({ afterDescription, activity }) => props.editor(afterDescription, current => { discussions.current = current; return activity(current) })}
    acceptance={props.acceptance}
    artifacts={props.artifacts}
    copyLink={menu.copyLink}
    subtasks={preview ? null : { items: subtasks, done: subtasks.filter(item => item.done).length, total: subtasks.length, onCreate: connections.error ? async () => false : menu.createChild, disabled: locked || connections.pending || Boolean(connections.error), failed: connections.error ? { text: tRelations('readFailedRetry'), retry: () => { void connections.mutate() } } : null }}
    activity={preview ? null : {
      items: activityItems, timeline: (current, additional) => activityItems(current, true, additional),
      earlier: { hasMore: props.earlierActivity.hasMore, loading: props.earlierActivity.loading, failed: props.earlierActivity.failed, load: props.earlierActivity.load },
      failed: [...props.historyFailed ? [{ text: tDetail('activityFailed'), retry: props.historyFailed }] : [], ...props.agentActivity.failed ? [{ text: props.agentActivity.failed.label, retry: props.agentActivity.failed.retry }] : [], ...pullRequestTimeline.data?.failed ? [{ text: tActivity('timelinePullFailed'), retry: () => { void pullRequestTimeline.mutate() } }] : []],
      drafts, subscribed: menu.subscribed, onSubscribe: menu.toggleSubscribed, subscribeLabel: menu.subscribed ? tFrame('unsubscribe') : tFrame('subscribe'),
    }}
    rows={rows}
    rowsError={metadata.error || team.failed || (presentation.error ? actionError() : '')}
    // Capy's line under the title: the code and how long ago it was made.
    meta={[task.identifier, format.relativeTime(created, now)].filter(Boolean).join(' · ')}
    panel={props.panel} wide={props.wide} resize={props.resize}
    dialogs={<>{props.dialogs}{menu.dialogs}{startingWork && <Suspense fallback={null}><StartWorkDialog open onOpenChange={setStartingWork} workspaceId={task.workspaceId ?? undefined}
      task={{ id: task.id, identifier: task.identifier, title: props.title || task.title }} initialBotId={meta.delegate?.kind === 'bot' ? meta.delegate.id : undefined} /></Suspense>}<AccessChangeDialog change={metadata.accessChange} pending={metadata.pending} onConfirm={metadata.confirmAccess} onCancel={metadata.cancelAccessChange} /><IssueMetadataControls task={task} section="dialog" disabled={locked} onSaved={adopt} onBusyChange={props.onMetadataBusy} request={props.propertyRequest} /></>}
  />
}

/** The icon that leads an event row, as Capy's: the new status's own icon for a move, the priority's bars, else the kind of change. */
function glyphOf(item: ActivityEventItem): TaskActivityGlyph {
  switch (item.kind) {
    case 'status': return item.status ? { kind: 'status', value: item.status } : { kind: 'event', value: 'edit' }
    case 'priority': return item.priority ? { kind: 'priority', value: item.priority } : { kind: 'event', value: 'edit' }
    case 'created': return { kind: 'event', value: 'created' }
    case 'title': case 'description': case 'dueDateChanged': case 'projectChanged': case 'estimateChanged': return { kind: 'event', value: 'edit' }
    case 'assigned': case 'unassigned': return { kind: 'event', value: 'assignee' }
    case 'parent': case 'subtask': return { kind: 'event', value: 'hierarchy' }
    case 'relation': return { kind: 'event', value: item.relation === 'related' ? 'related' : 'blocked' }
    case 'pull': return { kind: 'event', value: item.pullAction === 'merged' ? 'pullMerged' : 'pull' }
    case 'unsupported': return { kind: 'event', value: 'unsupported' }
  }
}

/** Which relation a 相关 row really is: a closed block shows as related but is removed as the block it is. */
function relationOf(kind: RelationKind, row: { id: string; metadata: { blockedByIds: string[] } }, current: { blockedByIds: string[] }, taskId: string): RelationKind {
  if (kind !== 'related') return kind
  if (current.blockedByIds.includes(row.id)) return 'blockedBy'
  if (row.metadata.blockedByIds.includes(taskId)) return 'blocks'
  return kind
}
