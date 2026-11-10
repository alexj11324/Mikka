// What the acceptance slot receives (docs/ui-overlay.md): 验收 on a task's page as a short block. Acceptance itself is
// the Artifact window (decision 2026-11-04-2200): the report on the left, the task's conversation on the right, where a
// change is asked for. Every value, word and action comes from the public components (components/workspace/
// factory-flow.tsx, factory-acceptance.tsx, factory-acceptance-pane.tsx); a layer only lays them out.
import type { StatusTone } from '@/lib/status-appearance'

/** One action. `href` opens in a new tab instead of `onSelect`. */
export type AcceptanceAction = {
  id: string
  label: string
  onSelect?: () => void
  href?: string
  disabled?: boolean
  /** This action is running. */
  busy?: boolean
}

/** A line under the block: a refusal or failure the last action got. */
export type AcceptanceNotice = { id: string; text: string; detail?: string }

/** 验收 under a task's description: what it is, the one thing to do now, and what was checked by whom. */
export type AcceptanceBlockProps = {
  taskId: string
  /** 验收 / 技能验收 */
  title: string
  /** PR #12, or the deliverable or skill; opens the PR when `href` is set. */
  subject: { label: string; href?: string } | null
  /** The state in a word, with its colour (方案待审, 已合并 …). */
  state: { label: string; tone: StatusTone } | null
  /** While the work goes on: 「正在实现…」; the block then says nothing else. */
  status: string | null
  /** What was checked and by whom: 「4 项通过 · 1 项未验证（实现自测）· 审阅：建议合并（仅供参考）」. */
  summary: string | null
  /** Why it stopped (blocked, failed, GitHub refused the merge), with the code under it. */
  problem: { text: string; detail?: string } | null
  /** The one action for now: 查看 PR 并合并, 接受, 启用, 合并中…, 在 GitHub 打开, 批准方案, 重试审阅 … */
  primary: AcceptanceAction | null
  /** Quiet actions on the last line: 打开验收报告 ↗, 查看方案, 撤销批准, 打开验收页 (the full acceptance when there is no report). */
  links: AcceptanceAction[]
  notices: AcceptanceNotice[]
}
