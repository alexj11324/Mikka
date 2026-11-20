import { z } from 'zod'
import type { ResolvedSetting } from './settings'

/** New ordinary Bots and root threads; independent of share-link audiences. */
export const workVisibilitySchema = z.enum(['private', 'shared'])
export type WorkVisibility = z.infer<typeof workVisibilitySchema>

/** A policy restriction does not masquerade as the source of a preference. */
export interface WorkCreationView {
  configured: ResolvedSetting<WorkVisibility>
  effectiveVisibility: WorkVisibility
  privateAllowed: boolean
  reason: 'configured' | 'workspace_policy' | 'personal_workspace'
}
