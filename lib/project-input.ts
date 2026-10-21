import { z } from 'zod'
import { WORKSPACE_TEAM_KEY } from '@/components/workspace/issue-properties'

export const DEFAULT_PROJECT_PROPERTIES = { color: 'green' as const, members: [] as 'me'[], labels: [] as string[], dependencyIds: [] as string[], milestones: [] as { id: string; name: string; targetDate: string; completed: boolean }[] }
const date = z.union([z.literal(''), z.iso.date()])
export const projectProperties = z.object({
  color: z.enum(['green', 'purple', 'yellow', 'gray']),
  health: z.enum(['none', 'onTrack', 'atRisk', 'offTrack']).optional(),
  members: z.array(z.literal('me')).max(1),
  labels: z.array(z.string().trim().min(1).max(50)).max(20),
  dependencyIds: z.array(z.uuid()).max(50),
  milestones: z.array(z.object({ id: z.uuid(), name: z.string().trim().min(1, 'validationProjectMilestoneName').max(200), targetDate: date, completed: z.boolean() })).max(50),
}).superRefine((value, context) => {
  for (const key of ['members', 'labels', 'dependencyIds'] as const) if (new Set(value[key]).size !== value[key].length) context.addIssue({ code: 'custom', message: 'validationProjectDuplicate', path: [key] })
  if (new Set(value.milestones.map(item => item.id)).size !== value.milestones.length) context.addIssue({ code: 'custom', message: 'validationProjectMilestoneDuplicate', path: ['milestones'] })
})
export const projectFields = z.object({
  name: z.string().trim().min(1, 'validationProjectNameRequired').max(200),
  summary: z.string().trim().max(500), description: z.string().max(50000),
  status: z.enum(['backlog', 'planned', 'started', 'paused', 'completed', 'canceled']),
  priority: z.enum(['none', 'urgent', 'high', 'normal', 'low']), lead: z.enum(['', 'me']),
  team: z.literal(WORKSPACE_TEAM_KEY), startDate: date, targetDate: date,
  properties: projectProperties.default(DEFAULT_PROJECT_PROPERTIES),
})
export const projectInput = projectFields.extend({ id: z.uuid().optional(), revision: z.number().int().positive().optional() }).refine(value => !value.startDate || !value.targetDate || value.startDate <= value.targetDate, 'validationProjectDateOrder')
export const projectPatch = z.object({ id: z.uuid(), revision: z.number().int().positive(), changes: projectFields.partial().extend({ properties: projectProperties.optional() }).refine(value => Object.keys(value).length > 0, 'validationProjectChangesRequired') })
export type ProjectDraft = z.output<typeof projectFields>
export type ProjectChanges = z.input<typeof projectPatch>['changes']

export function hasDependencyCycle(id: string, dependencyIds: string[], graph: { id: string; properties: { dependencyIds: string[] } }[]) {
  const edges = new Map(graph.map(item => [item.id, item.properties.dependencyIds]))
  edges.set(id, dependencyIds)
  const visited = new Set<string>()
  const active = new Set<string>()
  function visit(node: string): boolean {
    if (active.has(node)) return true
    if (visited.has(node)) return false
    active.add(node)
    if ((edges.get(node) ?? []).some(visit)) return true
    active.delete(node); visited.add(node)
    return false
  }
  return visit(id)
}
