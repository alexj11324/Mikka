/**
 * A factory task's flow on the phone (decisions/2026-11-04-2200-factory-flow-like-warp.md): one stage, 分诊 → 方案 →
 * 实现 → 审阅 → 交给你 → 完成 (or 已取消), plus an optional 「需要你」 kind; verification belongs to 实现, and 审阅 runs
 * once with one verdict. The shape is the public flow projection (lib/factory/public-flow.ts) the web reads from
 * /api/factory/tasks/:id/flow; the mobile task read does not send it yet (`task.flow`), and without it nothing shows.
 */
export type FlowStage = 'triage' | 'spec' | 'implement' | 'review' | 'handoff' | 'completed' | 'cancelled'
export type NeedsYouKind = 'spec_review' | 'question' | 'pr_review' | 'blocked' | 'failed'
export type ReviewVerdict = 'passed' | 'changes_requested' | 'needs_judgment'
export type TaskFlow = { stage: FlowStage; needsYou?: { kind: NeedsYouKind; since: string } | null; review?: { verdict: ReviewVerdict | null } | null }

export const STAGE_WORD: Record<FlowStage, string> = { triage: '分诊', spec: '方案', implement: '实现', review: '审阅', handoff: '交给你', completed: '完成', cancelled: '已取消' }
export const NEEDS_YOU_WORD: Record<NeedsYouKind, string> = { spec_review: '方案待审', question: '在问你', pr_review: 'PR 待审', blocked: '阻塞', failed: '失败' }
export const VERDICT_WORD: Record<ReviewVerdict, string> = { passed: '通过', changes_requested: '需要修改', needs_judgment: '需要你判断' }

/** The line at the top of the task's conversation: 「审阅」, or 「交给你 · 需要你：PR 待审」. Null without a flow. */
export function stageLine(flow: TaskFlow | null | undefined) {
  if (!flow || !(flow.stage in STAGE_WORD)) return null
  const needs = flow.needsYou && flow.needsYou.kind in NEEDS_YOU_WORD ? `需要你：${NEEDS_YOU_WORD[flow.needsYou.kind]}` : null
  return [STAGE_WORD[flow.stage], needs].filter(Boolean).join(' · ')
}

/** 审阅's verdict in words, or null while it has none (still reviewing, or no flow from the server). */
export const verdictWord = (flow: TaskFlow | null | undefined) => flow?.review?.verdict ? VERDICT_WORD[flow.review.verdict] ?? null : null
