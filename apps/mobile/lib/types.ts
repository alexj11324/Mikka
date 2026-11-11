/** The shapes app/api/mobile/* and /api/suggestions return (see those routes on the server). */
import type { SubscriptionRefusalNotice } from '../../../lib/subscription-refusal'
import type { CloudErrorCode } from '../../../lib/cloud-services/errors'
import type { PresenceProof } from '../../../lib/live/presence'
export type Source = 'gmail' | 'github' | 'slack' | 'notion' | 'linear' | 'googlecalendar'
export type MachineKind = 'cloud' | 'laptop' | 'server'
export type ThreadStatus = 'running' | 'waiting' | 'paused' | 'failed' | 'done' | 'stopped'

export interface Person { id: string; name: string; email: string; image: string | null }
export interface Workspace { id: string; name: string }

/** The person's own state for a chat on the home list (lib/chat-preferences.ts on the server). Absent from a server older than it. */
export interface ChatOwnState { hidden?: boolean; markedUnread?: boolean; pinOrder?: number | null; listOrder?: number | null }

export interface HomeBot extends ChatOwnState { id: string; name: string; color: string; shape: string; /** Plain text; an empty string is a card with no words. */ line: string | null; at: string | null; working: boolean; pinned?: boolean; /** The person's Coordinator: the app draws it pinned on top, not as a row. */ coordinator?: boolean; /** Its threads waiting on the person. */ waiting?: number }

export interface Home {
  user: Person
  workspace: Workspace
  workspaces: Workspace[]
  bots: HomeBot[]
  threads: { running: number; waiting: number }
  suggestions: number
  /** The person's own state for the group chats they changed on the home list, by conversation id. */
  groupPreferences?: Record<string, ChatOwnState & { pinned: boolean }>
  /** The person's own home channel for live keys (lib/live.ts); absent from a server older than it. */
  live?: LiveScope
}

/** Where a read's live keys arrive: the reader's id and the channel's workspace (null: none, read once a minute). */
export interface LiveScope { ownerId: string; workspaceId: string | null }

export interface IssueSource { kind: 'issue'; id: string; identifier: string | null; number: number | null; title: string; status: string }
export interface RunSource {
  kind: 'run'; id: string; name: string; agentName: string; harness: string; status: string
  /** Its group in the thread list (R-52), decided on the server. Absent from a server older than it. */
  group?: ThreadGroup
  issue: { id: string; identifier: string | null; number: number | null; title: string
    /** A code task's review summary (#1738, from #1722); absent for a non-code task or an older server. */
    review?: import('../features/review/model/contract').ReviewSummary | null } | null
  /** 运行信息, on the person's own runs. */
  info?: import('./run-info').RunInfo
}
export type CitationSource = IssueSource | RunSource

export interface ChatItem {
  /** eve mirror identity; native replay is hidden once this historical row arrives. */
  streamId?: string
  id?: string
  position: number
  from: 'person' | 'coordinator' | 'event'
  text: string
  threads: string[]
  artifacts: string[]
  createdAt: string
  pending?: true
  /** Photos the person sent with it, loaded from /api/mobile/chat/image. */
  images?: number
  /** The person stopped this reply (停止); it keeps what it had said. */
  stopped?: true
  /** An event, as the line the chat shows; its `text` is for the model only (lib/coordinator/event-line.ts on the server). */
  line?: EventLine
}

/** lib/coordinator/event-line.ts on the server. */
export interface EventLine {
  kind: 'runFinished' | 'runRetried' | 'runSwitched' | 'runPaused' | 'runWaitingDevice' | 'runDeviceBack' | 'issueStatus' | 'issueSnapshot' | 'runReport' | 'runQuestion' | 'runBlocked' | 'artifact' | 'action' | 'scheduleRan' | 'scheduleDue' | 'other'
  runId: string | null
  issueId: string | null
  status: string | null
  title: string | null
}

export interface Chat {
  /** The resolved chat row, including a workspace's Coordinator. Sends freeze this when known. */
  botId?: string
  enabled: boolean
  working: boolean
  error: string | null
  items: ChatItem[]
  sources: Record<string, CitationSource>
  artifacts: Record<string, { id: string; title: string }>
  /** By message id. */
  reactions?: Record<string, Reaction[]>
  /** Why the last reply did not come (lib/chat-failure.ts on the server); null while working or when nothing failed. */
  failure?: ChatFailure | null
  /** Its live key's channel, and while a reply is coming the moment its lease runs out. */
  live?: LiveScope & { deadline?: { at: string; afterMs: number } }
}

/** lib/chat-failure.ts on the server. */
export type ChatFailure = (
  | { kind: 'hosted'; code: string }
  | { kind: 'subscription'; notice: SubscriptionRefusalNotice }
  | { kind: 'wake'; code: 'wake_failed' | 'wake_start_unconfirmed' | 'wake_exhausted' }
  | { kind: 'failed'; reason?: 'balance' | 'tools'; cloudCode?: CloudErrorCode }
  // The stored code(s), shown only under 详情 (the web's RunErrorDetails); older servers omit it.
) & { raw?: string }

/** Reactions on a message, by emoji (lib/reactions.ts on the server). */
export interface Reaction { emoji: string; count: number; mine: boolean }

/** A group chat in 对话 (GET /api/conversations). */
export interface GroupSummary {
  id: string
  title: string
  createdAt: string
  lastMessage: GroupMessage | null
  unreadCount: string
  /** The workspace it lives in: its members' live keys arrive on that channel. */
  workspaceId?: string
}

/** One message in a group chat; `position` is a string (a bigint). */
export interface GroupMessage { id: string; position: string; authorType: 'user' | 'agent' | 'bot'; authorId: string; body: string; createdAt: string }

/** A group's member (GET /api/conversations/<id>/members); a bot has its colour and shape. */
export interface GroupMember { id: string; name: string; memberType: 'user' | 'agent' | 'bot'; avatarUrl: string | null; color?: string; shape?: string }

/** GET /api/conversations/<id>/messages: newest first. */
export interface GroupPage {
  messages: GroupMessage[]
  nextBefore: string | null
  agentStatus: { agentId: string | null; botId: string | null; status: string } | null
  routingError: { code: string } | null
  /** The latest reply was stopped (停止) by a member. */
  stopped?: boolean
}

export interface Thread {
  id: string
  name: string
  status: ThreadStatus
  by: string
  harness: string
  device: { id: string; name: string; kind: MachineKind } | null
  createdAt: string
  finishedAt: string | null
  /** Its place in the list, as on the web (R-52). Absent from a server older than it. */
  group?: ThreadGroup
  /** How many threads its task has had; the list shows only the newest. */
  attempts?: number
}

/** 等待你, 进行中, 受阻, 空闲, 已解决, in that order (R-52). */
export type ThreadGroup = 'running' | 'blocked' | 'waiting' | 'idle' | 'resolved'

/** A bot's page (GET /api/mobile/bots/<id>): its threads, its tasks' PRs, its scheduled tasks, its 资料库 and the person's 置顶 / 通知. */
export interface BotPage {
  threads: Thread[]
  pullRequests: { url: string; number: number; title: string; group: 'review' | 'running' | 'merged' }[]
  schedules: { id: string; title: string; status: 'active' | 'paused'; nextAt: string | null }[]
  /** 资料库: what its threads handed over, newest first. */
  library: { id: string; title: string; kind: 'markdown' | 'html'; version: number; updatedAt: string }[]
  pinned: boolean
  muted: boolean
}

/** A bot's cloud computer (GET /api/bots/<id>/computer), as far as the app shows it. */
export interface ComputerStatus { machine: 'sleeping' | 'waking' | 'running' | 'error'; control: 'agent' | 'user' | 'idle'; /** Its live key's channel and next silent change (lib/computer/state-deadline.ts). */ live?: { workspaceId: string; deadline?: { at: string; afterMs: number } } }

export interface Threads { threads: Thread[]; devices: { id: string; name: string; kind: MachineKind; online: boolean }[]; live?: LiveScope & { presence?: PresenceProof | null } }

/** Optional result fields are absent on older servers or when timing is unknown. */
export type ThreadStep = { id: string; name: string; detail: string | null; failed: boolean; output?: string; ms?: number }

export type ThreadItem =
  | { kind: 'agent'; id: string; text: string; at: number }
  | { kind: 'steps'; id: string; count: number; steps?: ThreadStep[]; at: number }
  | { kind: 'error'; id: string; text: string; at: number }
  | { kind: 'person'; id: string; text: string; mine: boolean; at: number }

/** A thread paused because its subscription ran out (the web's ThreadQuotaPausedCard). */
export interface ThreadPaused { runId: string; subscription: 'claude' | 'codex'; plan: string | null; resetsAt: string | null; keyReady: boolean }
export interface ThreadDetail { /** Each run's live channel (lib/live/panels.ts threadLiveReferences); absent from a server older than it. */ live?: { runs: { id: string; workspaceId: string | null }[] }; thread: Thread; active: boolean; /** Generating or running, not waiting for an answer: only then does the composer's button stop. */ working?: boolean; paused?: ThreadPaused | null; summary: string | null; error: string | null; items: ThreadItem[] }

export interface Suggestion { id: string; source: Source; action: string; title: string; url: string | null; actor: string | null; occurredAt: string }
export interface Suggestions { groups: { source: Source; items: Suggestion[] }[] }

/** Why a task is 受阻 (lib/task-blocked.ts on the web): its newest thread, a task it waits on (`blocker`, its number), or the person's flag. */
export type TaskBlockReason = 'question' | 'quota' | 'run' | 'failed' | 'dependency' | 'flagged'
export interface Task { id: string; identifier: string | null; title: string; status: string; priority: string; owner: string | null; updatedAt: string
  /** Absent from a server older than 受阻. */
  blocked?: { reason: TaskBlockReason; blocker: string | null } | null
  /** Its list group from its current thread (R-52, 2026-11-07); absent from an older server (features/tasks/model/task-groups.ts). */
  group?: TaskGroup
  /** The bot that dispatched it. */
  bot?: TaskBot | null
  /** A scheduled task's next run. */
  schedule?: TaskSchedule | null
  createdAt?: string
  /** Its state (decisions/2026-11-07-2230): an attempt's in 等待你 and 进行中, else its board status. Absent from an older server. */
  state?: ServerTaskState | null
  /** Why, as a code; the app writes the words (features/tasks/model/task-groups.ts REASON_WORD). */
  reason?: TaskReason | null
  /** The blocking task's identifier when `reason` is blocked_by. */
  blockedBy?: string | null }

/** One icon per state (decisions/2026-11-07-2230-one-icon-per-task-state.md); open and closed tasks show their board status. */
export type TaskState = 'waiting' | 'failed' | 'blocked' | 'running' | 'queued'
/** The API's `state`: the four attempt states, or the board status of an open or closed task. */
export type ServerTaskState = TaskState | 'todo' | 'done' | 'canceled' | 'duplicate'
export type TaskReason = 'needs_input' | 'approval' | 'pr_review' | 'blocked' | 'quota' | 'offline' | 'blocked_by' | 'flagged'

/** 待处理 · 进行中 · 待办 · 已完成 (decisions/2026-11-07-2045-tasks-only-threads-inside.md). */
export type TaskGroup = 'pending' | 'running' | 'todo' | 'done'
export interface TaskBot { id: string; name: string; color?: string; shape?: string }
export interface TaskSchedule { label: string; nextAt: string | null }

/** One entry of a task's 活动, newest first. */
export type TaskActivity =
  | { kind: 'attempt'; runId: string; n: number; group: ThreadGroup; harness: string; createdAt: string; failed: boolean
    /** Its own result (2026-11-07-2230); absent from an older server. */
    state?: 'running' | 'waiting' | 'failed' | 'blocked' | 'done'
    /** The pull request it opened; absent from an older server. */
    pullRequest?: { number: number; url?: string | null } | null
    /** The factory stage this run did (lib/mobile-tasks.ts, coming); absent or null when it was not a factory stage. */
    stage?: 'implement' | 'fix' | 'review' | 'verify' | null }
  | { kind: 'replaced'; runId: string; createdAt: string }
  | { kind: 'created'; by: string | null; createdAt: string }

/** GET /api/mobile/tasks/:id (lib/mobile-tasks.ts on the server): the task's detail and its 活动, newest first. */
export interface TaskDetail {
  task: Pick<Task, 'id' | 'identifier' | 'title' | 'status' | 'priority' | 'group' | 'state' | 'reason' | 'blockedBy'> & {
    factoryTaskId?: string
    bot: TaskBot | null
    schedule: TaskSchedule | null
    description: string | null
    agent: { harness: string; model: string | null } | null
    place: { kind: MachineKind; name: string } | null
    /** A code task's review summary (#1738, from #1722); absent for a non-code task or an older server. */
    review?: import('../features/review/model/contract').ReviewSummary | null
    /** A factory task's flow: its stage, what it needs from the person, 审阅's verdict (2026-11-04-2200). Not sent yet. */
    flow?: import('../features/tasks/model/task-flow').TaskFlow | null
  }
  /** Raw, authorized receipts from the selected Factory response. The UI decodes its supported DTO version. */
  factoryEvents?: unknown[]
  activity: TaskActivity[]
  /** The channel its task and run keys arrive on. */
  live?: { workspaceId: string; factoryActivityVersion?: 1 }
}

export interface Preferences {
  proactive: boolean
  pushDecide: boolean
  pushReview: boolean
  pushFinished: boolean
  pushBriefing: boolean
  pushWhen: 'always' | 'away'
  memoryEnabled: boolean
  /** The web composer's send key; mobile keeps its own keyboard behaviour. */
  sendKey: 'enter' | 'modEnter'
  /** The person's own instructions for the Coordinator and their Bots, at most 2000 characters. */
  personalInstructions: string
  /** 每日建议; always false while memoryEnabled is false. */
  dailySuggestions: boolean
}

export interface Settings {
  /** Fresh finance entry scope; absent on older servers. */
  billingScope?: { kind: 'workspace' | 'organization'; id: string } | null
  user: Person
  workspace: Workspace
  workspaces: Workspace[]
  preferences: Preferences
  memory: string
  apps: { app: Source; connected: boolean; account: string | null }[]
}

/** A run as people name it on a card or a chip: its task's title, never the task's key (#1386). */
export function runName(run: RunSource): string {
  return run.issue?.title || run.name
}

/** A proposal waiting for the person (`GET /api/pending-actions`; lib/pending-action-view.ts on the server). */
export interface PendingAction {
  id: string
  action: 'send_email' | 'create_calendar_event' | 'update_calendar_event' | (string & {})
  input: Record<string, unknown>
  context: { summary?: string; start?: string; end?: string } | null
  status: string
  createdAt: string
}

/** 插件 › 应用: the store (GET /api/integrations/composio/catalog, lib/plugins/catalog.ts). */
export interface StoreCatalog {
  configured: boolean
  apps: { id: string; name: string; description: string; iconUrl: string | null }[]
  popular: string[]
  latest: string[]
}

/** The person's connected accounts (GET /api/integrations/composio). */
export interface ComposioAccounts { configured: boolean; accounts: { id: string; toolkit: string; status: string; alias: string | null; email: string | null }[] }

/** 插件 › 技能: one page of skills.sh (GET /api/skills/search). */
export interface SkillsPage { data: { id: string; name: string; source: string; installs: number; url: string }[]; hasMore: boolean }
