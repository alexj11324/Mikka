import { mobileMessages } from '../../../lib/messages'

/**
 * A factory task's flow on the phone (decisions/2026-11-04-2200-factory-flow-like-warp.md): one stage, 分诊 → 方案 →
 * 实现 → 审阅 → 交给你 → 已合并 (or 已取消), plus an optional 「需要你」 kind; verification belongs to 实现, and 审阅 runs
 * once with one verdict. The shape is the public flow projection (lib/factory/public-flow.ts) the web reads from
 * /api/factory/tasks/:id/flow; the mobile task read does not send it yet (`task.flow`), and without it nothing shows.
 */
export type FlowStage = 'triage' | 'spec' | 'implement' | 'review' | 'handoff' | 'completed' | 'cancelled'
export type NeedsYouKind = 'spec_review' | 'question' | 'pr_review' | 'blocked' | 'failed'
export type ReviewVerdict = 'passed' | 'changes_requested' | 'needs_judgment'
export type TaskFlow = { stage: FlowStage; needsYou?: { kind: NeedsYouKind; since: string } | null; review?: { verdict: ReviewVerdict | null } | null }

/** The web's words for the same flow (FactoryFlow), so both read alike. */
export const STAGE_WORD: Record<FlowStage, string> = mobileMessages.FactoryFlow.stages
export const NEEDS_YOU_WORD: Record<NeedsYouKind, string> = mobileMessages.FactoryFlow.card.needsYou
export const VERDICT_WORD: Record<ReviewVerdict, string> = mobileMessages.MobileCore.conversation.verdicts

/** The line at the top of the task's conversation: 「审阅」, or 「交给你 · 需要你：PR 待审」. Null without a flow. */
export function stageLine(flow: TaskFlow | null | undefined) {
  if (!flow || !(flow.stage in STAGE_WORD)) return null
  const needs = flow.needsYou && flow.needsYou.kind in NEEDS_YOU_WORD ? mobileMessages.MobileCore.conversation.needsYou.replace('{what}', NEEDS_YOU_WORD[flow.needsYou.kind]) : null
  return [STAGE_WORD[flow.stage], needs].filter(Boolean).join(' · ')
}

/** 审阅's verdict in words, or null while it has none (still reviewing, or no flow from the server). */
export const verdictWord = (flow: TaskFlow | null | undefined) => flow?.review?.verdict ? VERDICT_WORD[flow.review.verdict] ?? null : null
