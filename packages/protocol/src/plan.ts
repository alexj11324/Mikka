// What a `plan` run hands in (Stage 1.5, ADR ORV-205). A planner writes no code:
// it writes a product-level spec, proposes how to split it into issues, and
// asks the questions it cannot answer itself. The daemon turns the spec and
// the split into `data-spec` / `data-split` parts of the run's transcript; the
// server stores them on the `spec` row. A split creates nothing until a person
// approves it (`split.approve`), so the proposal has to be complete enough to
// build the whole tree from: keys, parents, blockers and AC-n criteria.
import { z } from "zod"

/** A required, trimmed string. */
const text = (max: number) => z.string().trim().min(1).max(max)

/** A short identifier, unique inside one split plan. */
const key = z.string().trim().min(1).max(64)

/** One section of the spec card: a heading and its bullets. */
export const planSection = z.object({
  heading: text(200),
  items: z.array(text(2_000)).min(1).max(50),
})
export type PlanSection = z.infer<typeof planSection>

/**
 * The product-level spec a planner writes and a person approves before any
 * issue exists. The shape is the spec card's: what the agent hands in is what
 * the conversation shows.
 */
export const planSpec = z.object({
  title: text(500),
  summary: z.string().trim().max(4_000).default(""),
  sections: z.array(planSection).min(1).max(30),
})
export type PlanSpec = z.infer<typeof planSpec>

/** One acceptance criterion of a proposed issue (ADR 0042: AC-n in order). */
export const planCriterion = z.object({
  body: text(2_000),
  /** The command that checks it; absent means a person checks it. */
  checkCommand: z.string().trim().max(2_000).optional(),
})
export type PlanCriterion = z.infer<typeof planCriterion>

export const PLAN_PRIORITIES = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
] as const
export type PlanPriority = (typeof PLAN_PRIORITIES)[number]

/**
 * One issue of a proposed split. `key` is local to the plan: `parentKey` and
 * `blockedBy` name other keys, so the whole tree and its order are expressible
 * before any issue row exists. Every issue carries at least one criterion —
 * an issue nobody can say "done" about is what the split is for (ADR 0044).
 */
export const planIssue = z.object({
  key,
  title: text(500),
  goal: z.string().trim().max(4_000).optional(),
  /** Grouping only; order lives in `blockedBy` (`issue.parent_id`). */
  parentKey: key.optional(),
  blockedBy: z.array(key).max(50).default([]),
  criteria: z.array(planCriterion).min(1).max(50),
  verifyCommand: z.string().trim().max(2_000).optional(),
  predictedFiles: z.array(z.string().trim().max(1_000)).max(200).default([]),
  sizeEstimate: z
    .object({ files: z.number().int().min(0), lines: z.number().int().min(0) })
    .optional(),
  priority: z.enum(PLAN_PRIORITIES).default("none"),
})
export type PlanIssue = z.infer<typeof planIssue>

/** The split a person approves before any issue is created. */
export const planSplit = z.object({
  summary: z.string().trim().max(4_000).default(""),
  issues: z.array(planIssue).min(1).max(100),
})
export type PlanSplit = z.infer<typeof planSplit>

/**
 * A `plan` run's whole hand-in: the id its spec is stored under, the spec,
 * and the split it proposes. The daemon generates `specId` when the agent
 * hands in, so the cards in the conversation and the row the server writes
 * name the same spec.
 */
export const planHandoff = z.object({
  specId: z.uuid(),
  spec: planSpec,
  split: planSplit,
})
export type PlanHandoff = z.infer<typeof planHandoff>

export const PLAN_SPLIT_LIMITS = { issues: 100, criteria: 50 } as const

/**
 * The plan's priority as `issue.priority` stores it. The two orders are the
 * same on purpose: the sidebar's list (`PRIORITY_OF` in the desktop app) is
 * none, urgent, high, medium, low, so the index is the stored value.
 */
export function planPriorityValue(priority: PlanPriority): 0 | 1 | 2 | 3 | 4 {
  return PLAN_PRIORITIES.indexOf(priority) as 0 | 1 | 2 | 3 | 4
}

/**
 * Why a split cannot be turned into issues, or null when it can: keys have to
 * be unique, `parentKey` and `blockedBy` have to name keys in the same plan,
 * and the parent and blocker edges have to stay acyclic. The same check runs
 * when the planner hands the split in and again when a person approves it, so
 * a proposal stored by an older daemon cannot create a broken tree.
 */
export function planSplitProblem(split: PlanSplit): string | null {
  const byKey = new Map<string, PlanIssue>()
  for (const issue of split.issues) {
    if (byKey.has(issue.key)) return `Two issues share the key "${issue.key}".`
    byKey.set(issue.key, issue)
  }
  for (const issue of split.issues) {
    if (issue.parentKey === issue.key)
      return `"${issue.key}" cannot be its own parent.`
    if (issue.parentKey && !byKey.has(issue.parentKey))
      return `"${issue.key}" has an unknown parent "${issue.parentKey}".`
    for (const blocker of issue.blockedBy) {
      if (blocker === issue.key)
        return `"${issue.key}" cannot be blocked by itself.`
      if (!byKey.has(blocker))
        return `"${issue.key}" is blocked by an unknown issue "${blocker}".`
    }
  }
  const cycle = firstCycle(byKey)
  return cycle ? `The plan has a cycle: ${cycle.join(" → ")}.` : null
}

/** A parent or blocked-by cycle as the keys that close it, or null. */
function firstCycle(byKey: Map<string, PlanIssue>): string[] | null {
  const edges = (issue: PlanIssue) => [
    ...(issue.parentKey ? [issue.parentKey] : []),
    ...issue.blockedBy,
  ]
  const state = new Map<string, "open" | "done">()
  const path: string[] = []
  const visit = (from: string): string[] | null => {
    if (state.get(from) === "open")
      return [...path.slice(path.indexOf(from)), from]
    if (state.get(from) === "done") return null
    state.set(from, "open")
    path.push(from)
    for (const next of edges(byKey.get(from)!)) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    path.pop()
    state.set(from, "done")
    return null
  }
  for (const issue of byKey.values()) {
    const cycle = visit(issue.key)
    if (cycle) return cycle
  }
  return null
}

const paragraph = (value: string) => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
})

/**
 * The spec card's sections as the rich-text document `spec.body` stores: the
 * summary as a lead paragraph, then a heading and its bullets per section. The
 * card reads the agent's own sections, so this is only what the issue page
 * shows once the spec exists.
 */
export function specDoc(spec: PlanSpec): {
  type: "doc"
  content: unknown[]
} {
  return {
    type: "doc",
    content: [
      ...(spec.summary ? [paragraph(spec.summary)] : []),
      ...spec.sections.flatMap((section) => [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: section.heading }],
        },
        {
          type: "bulletList",
          content: section.items.map((item) => ({
            type: "listItem",
            content: [paragraph(item)],
          })),
        },
      ]),
    ],
  }
}
