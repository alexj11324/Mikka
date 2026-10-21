// What a saved view stores (ADR ORV-8). The filter chips use the same shape as
// the Circle <DataTableFilter /> state, so applying a view is setting that
// state; display is the Display popover (grouping, ordering, shown columns).
import { z } from "zod"

export const VIEW_TYPES = ["issue", "project"] as const
export const VIEW_SCOPES = ["personal", "team", "workspace"] as const

// The keys are the Circle display store's own (`GroupingKey`, `OrderingKey`),
// so a saved view can be applied by handing them back to that store.
export const VIEW_GROUPINGS = [
  "none",
  "status",
  "assignee",
  "delegate",
  "priority",
  "project",
  "cycle",
] as const

export const VIEW_ORDERINGS = ["priority", "created", "title"] as const

export const viewFilterSchema = z.strictObject({
  columnId: z.string().min(1).max(100),
  type: z.string().min(1).max(50),
  operator: z.string().min(1).max(50),
  values: z.array(z.json()).max(200),
})
export const viewFiltersSchema = z.array(viewFilterSchema).max(30)

export const viewDisplaySchema = z.strictObject({
  grouping: z.enum(VIEW_GROUPINGS).optional(),
  ordering: z.enum(VIEW_ORDERINGS).optional(),
  orderCompletedByRecency: z.boolean().optional(),
  completedIssues: z.enum(["all", "none"]).optional(),
  showSubIssues: z.boolean().optional(),
  showEmptyGroups: z.boolean().optional(),
  /** Property key (id, status, labels, ...) to shown. */
  displayProperties: z.record(z.string().max(50), z.boolean()).optional(),
})

export type ViewFilter = z.infer<typeof viewFilterSchema>
export type ViewDisplay = z.infer<typeof viewDisplaySchema>
