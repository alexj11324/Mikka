/** The shapes app/api/mobile/* and /api/suggestions return (see those routes on the server). */
export type Source = 'gmail' | 'github' | 'slack' | 'notion' | 'linear' | 'googlecalendar'
export type MachineKind = 'cloud' | 'laptop' | 'server'
export type ThreadStatus = 'running' | 'waiting' | 'failed' | 'done' | 'stopped'

export interface Person { id: string; name: string; email: string; image: string | null }
export interface Workspace { id: string; name: string }

export interface HomeBot { id: string; name: string; color: string; shape: string; /** Plain text; an empty string is a card with no words. */ line: string | null; at: string | null; working: boolean; pinned?: boolean; /** The person's Coordinator: the app draws it pinned on top, not as a row. */ coordinator?: boolean }

export interface Home {
  user: Person
  workspace: Workspace
  workspaces: Workspace[]
  bots: HomeBot[]
  threads: { running: number; waiting: number }
  suggestions: number
}

export interface IssueSource { kind: 'issue'; id: string; identifier: string | null; number: number | null; title: string; status: string }
export interface RunSource {
  kind: 'run'; id: string; name: string; agentName: string; harness: string; status: string
  issue: { id: string; identifier: string | null; number: number | null; title: string } | null
}
export type CitationSource = IssueSource | RunSource

export interface ChatItem {
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
}

export interface Chat {
  enabled: boolean
  working: boolean
  error: string | null
  items: ChatItem[]
  sources: Record<string, CitationSource>
  artifacts: Record<string, { id: string; title: string }>
  /** By message id. */
  reactions?: Record<string, Reaction[]>
}

/** Reactions on a message, by emoji (lib/reactions.ts on the server). */
export interface Reaction { emoji: string; count: number; mine: boolean }

/** A group chat in 对话 (GET /api/conversations). */
export interface GroupSummary {
  id: string
  title: string
  createdAt: string
  lastMessage: GroupMessage | null
  unreadCount: string
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
  /** How many threads its task has had; the list shows only the newest (第 N 次尝试). */
  attempts?: number
}

/** 进行中, 受阻, 等待你, 空闲, 已解决, in that order (R-52). */
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
export interface ComputerStatus { machine: 'sleeping' | 'waking' | 'running' | 'error'; control: 'agent' | 'user' | 'idle' }

export interface Threads { threads: Thread[]; devices: { id: string; name: string; kind: MachineKind; online: boolean }[] }

export type ThreadItem =
  | { kind: 'agent'; id: string; text: string; at: number }
  | { kind: 'steps'; id: string; count: number; at: number }
  | { kind: 'error'; id: string; text: string; at: number }
  | { kind: 'person'; id: string; text: string; mine: boolean; at: number }

export interface ThreadDetail { thread: Thread; active: boolean; summary: string | null; error: string | null; items: ThreadItem[] }

export interface Suggestion { id: string; source: Source; action: string; title: string; url: string | null; actor: string | null; occurredAt: string }
export interface Suggestions { groups: { source: Source; items: Suggestion[] }[] }

export interface Task { id: string; identifier: string | null; title: string; status: string; priority: string; owner: string | null; updatedAt: string }

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
  user: Person
  workspace: Workspace
  workspaces: Workspace[]
  preferences: Preferences
  memory: string
  apps: { app: Source; connected: boolean; account: string | null }[]
}

/** A run's name as the app shows it: its task as "MIK-11 群聊建表" when it has one (glossary), else its own name. */
export function runTitle(run: RunSource): string {
  if (!run.issue) return run.name
  const key = run.issue.identifier ?? (run.issue.number === null ? null : `#${run.issue.number}`)
  return key ? `${key} ${run.issue.title}` : run.issue.title
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
