// What the acceptance slot receives (docs/ui-overlay.md): 验收 on a task's page and the pane it opens. Every value,
// word and action comes from the public components (components/workspace/factory-flow.tsx, factory-acceptance.tsx,
// factory-acceptance-pane.tsx); a layer only lays them out. Nothing here reads or writes.
import type { ReactNode } from 'react'
import type { FlowStage } from '@/lib/factory/flow-client'
import type { StatusTone } from '@/lib/status-appearance'

/** One action, in the order the open-source view offers them. `href` opens in a new tab instead of `onSelect`. */
export type AcceptanceAction = {
  id: string
  label: string
  onSelect?: () => void
  href?: string
  /** The one action the state leads with. */
  primary?: boolean
  /** A secondary action (send back, revoke, cancel). */
  quiet?: boolean
  disabled?: boolean
  /** This action is running. */
  busy?: boolean
}

/** A word with its colour, as the open-source badge draws it. */
export type AcceptanceState = { label: string; tone: StatusTone }

/** A line under the decision: a refusal, a failure, or what an action does. */
export type AcceptanceNotice = { id: string; tone: 'error' | 'warning' | 'neutral'; text: string; detail?: string }

/** A v2 task's block under the description (FactoryFlowCard): its stages, what it needs and the actions for it. */
export type AcceptanceFlowProps = {
  taskId: string
  /** 验收 */
  title: string
  state: AcceptanceState
  /** The stages this task goes through; skipped ones are not listed. */
  stages: {
    id: FlowStage
    label: string
    state: 'done' | 'running' | 'pending' | 'waiting' | 'failed'
    /** The person decides this stage (spec review, PR review). */
    gate: boolean
    /** What the current stage has to show: the acceptance counts, the review's verdict, the PR. */
    substeps?: { id: string; title: string; detail?: string; state?: 'done' | 'running' | 'pending' }[]
  }[]
  /** How long it has waited for the person, e.g. 「3 分钟前」. */
  waitingSince: string | null
  /** What it waits on (待你审阅规格 …), null when it waits on nothing. */
  needsYou: string | null
  /** What the person is asked to do, as a title (审阅 PR #12, 回答 Bot 的问题), or the PR / 验收结果 when nothing waits. */
  headline: string
  /** Why it stopped (blocked / failed). */
  reason: string | null
  /** The last 批准规格 failed: the words and its code. */
  error: { text: string; code: string | null } | null
  /** 打开规格, 批准规格 / 重试, 去回答, 查看 PR #n / 打开验收报告, 打开 PR */
  actions: AcceptanceAction[]
  /** The words a layer's template needs that the stages do not carry. */
  words: { done: string; running: string; waiting: string; failed: string; pending: string; approval: string }
}

/** An older task's acceptance row (FactoryAcceptanceRow); opening it opens the pane. */
export type AcceptanceRowProps = {
  taskId: string
  title: string
  reason: string | null
  state: AcceptanceState | null
  onOpen: () => void
}

/** A criterion or another evidence group, with the evidence that shows it. */
export type AcceptanceCriterion = {
  key: string
  title: string
  /** `none` is evidence with no criterion (其他证据). */
  verdict: 'passed' | 'failed' | 'unverified' | 'none'
  verdictLabel: string
  /** The evidence's names, joined. */
  evidence: string
  /** Opens the evidence viewer on this group's first item; missing when it has none. */
  onOpen?: () => void
}

/** The independent review or verify, and where it ran. */
export type AcceptanceResult = {
  key: string
  title: string
  status: 'passed' | 'failed' | 'running' | 'blocked'
  word: string
  /** 3/4, or 2 条意见 */
  meta: string | null
  /** The short sha it judged. */
  sha: string | null
  /** 审阅线程 / 验证线程: opens it when known. */
  thread: string
  onOpenThread?: () => void
  /** The executions a question command came from (来源执行), with their time. */
  sources: { key: string; label: string; at: string; onOpen?: () => void }[]
}

/** The 验收 pane (FactoryAcceptancePane outside the Artifact window). */
export type AcceptancePaneProps = {
  taskId: string
  /** 验收 / 技能验收 */
  title: string
  phase: 'loading' | 'error' | 'ready'
  /** The words when `phase` is error. */
  loadError: string
  state: AcceptanceState
  /** The decision waits for the person. */
  waiting: boolean
  /** 等你验收, 已合并 …: the decision's own state words. */
  decision: AcceptanceState
  /** Where the candidate ran (the machine). */
  machine: string | null
  /** The candidate: its PR first, then commit, preview, environment and target. */
  candidate: { id: string; label: string; value: string; href?: string; mono?: boolean; full?: string }[]
  /** The PR's title or the repository, for the gate's title. */
  headline: string | null
  /** 标准 / 证据 and how many passed */
  criteriaTitle: string
  criteriaCount: string | null
  criteria: AcceptanceCriterion[]
  /** No evidence group yet (暂无证据); null when the evidence is not read in this state. */
  criteriaEmpty: string | null
  resultsTitle: string
  results: AcceptanceResult[]
  notices: AcceptanceNotice[]
  actions: AcceptanceAction[]
  /** 要求修改's note, sent as the send-back. */
  reject: {
    open: boolean
    title: string
    label: string
    note: string
    error: string | null
    submitting: boolean
    canSubmit: boolean
    cancel: string
    submit: string
    onEdit: (note: string) => void
    onSubmit: () => void
    onCancel: () => void
  }
  /** The evidence viewer while one is open (rendered by Mikka). */
  viewer: ReactNode
  /** The panel's ✕ when the pane stands alone (FactoryAcceptancePanel). */
  onClose?: () => void
  closeLabel: string
}
