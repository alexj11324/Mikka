import type { ResolvedSetting } from '@mikka/protocol/settings'
import type { WorkCreationView, WorkVisibility } from '@mikka/protocol/work-visibility'

/** Creation policy is separate from P1's unchanged preference inheritance. */
export function workCreationView(kind: 'personal' | 'team', configured: ResolvedSetting<WorkVisibility>, allowPrivate: boolean): WorkCreationView {
  if (kind === 'personal') return { configured, effectiveVisibility: 'private', privateAllowed: true, reason: 'personal_workspace' }
  if (!allowPrivate) return { configured, effectiveVisibility: 'shared', privateAllowed: false, reason: 'workspace_policy' }
  return { configured, effectiveVisibility: configured.value, privateAllowed: true, reason: 'configured' }
}
