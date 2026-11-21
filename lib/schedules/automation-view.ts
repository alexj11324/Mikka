import type { Definition } from './contract'

/** A schedule as the 自动化 page reads it (the store's list row). */
export type AutomationView = {
  id: string
  owner_id: string
  workspace_id: string | null
  bot_id: string | null
  visibility: 'owner' | 'workspace'
  definition: Definition
  status: 'active' | 'paused' | 'cancelled' | 'completed'
  deleted?: boolean
  version: number
  next_at: string | Date | null
  created_at?: string | Date
  updated_at?: string | Date
  /** The creator's name in this workspace (null when they left it). */
  owner_name?: string | null
  /** The creator's picture (null without one). */
  owner_image?: string | null
  /** Runs as: the member each dispatched run acts, is billed and posts as; null is the creator. */
  run_as_user_id?: string | null
  /** That member's name in this workspace (null when they left it). */
  run_as_name?: string | null
  /** Why the host paused it (the creator lost the authority it runs on); null when a person paused it or it runs. */
  disabled_reason?: string | null
  /** 接手 is offered: the reader is an owner or admin and someone else created it. */
  can_take_over?: boolean
  /** A webhook URL was made for it (the URL itself is shown only once). */
  webhook_key_set?: boolean
  /** 文件夹 and 标签: the workspace's; 置顶: the reader's own. */
  folder?: string | null
  tags?: string[]
  pinned?: boolean
}
/** `counts`: the whole filtered list's 运行中 and 已暂停 sizes, with the first page only. */
export type AutomationList = { schedules: AutomationView[]; nextCursor: string | null; counts?: { active: number; paused: number } }

/** Receipt for a run cancelled before the worker claimed it. */
export type CancelledAutomationRun = {
  runId: string
  id: string
  automationId: string
  status: 'cancelled'
  jamId: null
  failure: null
  startedAt: string | Date | null
  completedAt: string | Date | null
  createdAt: string | Date
}

/** One run. `result` and `error` are blank for a member who is neither its creator nor an owner or admin. */
export type AutomationRun = {
  id: string
  due_at: string | Date
  started_at: string | Date | null
  finished_at: string | Date | null
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  can_cancel?: boolean
  attempts: number
  error: string | null
  result: unknown
  /** The event a run started on (blank for a member who is neither its creator nor an owner or admin). */
  trigger?: { event: { source?: 'github'; event: string; repository: string; number: number | null; title: string | null; url: string | null } }
    | { event: { source: 'linear'; event: string; identifier: string | null; title: string | null; url: string | null } }
    | { event: { source: 'slack'; event: string; channel: string; reaction: string | null } } | { webhook: { requests: { at: string }[] } } | null
}
/** Public batch metadata shared by history and the two closure actions. */
export type WebhookBatch = {
  id: string
  automationId: string
  status: 'collecting' | 'queued' | 'cancelled'
  runStatus: AutomationRun['status']
  /** The same ID as the run in automation history once this batch has flushed or started. */
  runId: string | null
  failure: string | null
  created_at: string | Date
  due_at: string | Date
  requestCount: number
  eventCount: number
  firstEventAt: string | null
  lastEventAt: string | null
  /** UTF-8 bytes of the accepted text. Older cancelled batches can already have erased it. */
  byteCount: number | null
  /** This webhook groups all admissions into a single window without a quiet-period timer. */
  group: []
  quietPeriodSeconds: null
  maxEvents: number
  maxWaitSeconds: number
  /** The admission deadline, or the recorded early flush time. An older early flush has no recorded time. */
  dispatchAfter: string | Date | null
  closedAt: string | Date | null
  reason: 'manual' | 'cancelled' | null
}
export type WebhookBatchClosure = WebhookBatch & {
  batchId: string
  status: 'queued' | 'cancelled'
  replayed: boolean
}
export type WebhookBatchPage = { batches: WebhookBatch[]; nextCursor: string | null }
export type AutomationHistory = { occurrences: AutomationRun[] }
export type AutomationUsageDay = { day: string; runs: number; skipped: number; tasks: number; costMicroUsd: number | null }
export type AutomationUsage = { timezone: string; maxRunsPerDay: number | null; days: AutomationUsageDay[] }

/** The task a dispatch_task run made, when the reader may see it. */
export function runTask(run: Pick<AutomationRun, 'result'>): { id: string; title: string; identifier: string | null } | null {
  const value = run.result
  if (!value || typeof value !== 'object') return null
  const { id, title, identifier } = value as Record<string, unknown>
  return typeof id === 'string' && typeof title === 'string' ? { id, title, identifier: typeof identifier === 'string' ? identifier : null } : null
}
