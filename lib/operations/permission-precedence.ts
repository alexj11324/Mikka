export type PermissionDecisionValue = 'allow' | 'ask' | 'deny'

/**
 * The one precedence for stored app/write permissions, shared by the app tool
 * path (lib/app-tools.ts) and the legacy write path (lib/operations/write-policy.ts):
 * restrictive wins. A deny in any layer, then an ask; only when neither
 * restricts does an allow run the call. Null when no layer names the action,
 * so the caller applies its own default (the Decision API, or `fallback`).
 */
export function permissionDecision(choices: readonly PermissionDecisionValue[]): PermissionDecisionValue | null {
  if (choices.includes('deny')) return 'deny'
  if (choices.includes('ask')) return 'ask'
  if (choices.includes('allow')) return 'allow'
  return null
}
