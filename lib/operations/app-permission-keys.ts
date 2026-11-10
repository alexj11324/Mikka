// One app-level permission key, with the legacy first-class write tool that
// acts in the same app. A settings page writes both so the app-level choice
// governs generic app tools and the older write path together.
export const LEGACY_WRITE_ACTIONS: Readonly<Record<string, string>> = {
  append_notion_paragraph: 'notion',
  send_slack_message: 'slack',
  cancel_calendar_event: 'googlecalendar',
}

export const LEGACY_APP_ACTIONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEGACY_WRITE_ACTIONS).map(([action, app]) => [app, action]),
)

export type AppPermissionValue = 'allow' | 'ask' | 'deny'

/** The keys that carry one app's choice: the app itself, then its legacy tool. */
export function appPermissionKeys(app: string): string[] {
  const legacy = LEGACY_APP_ACTIONS[app]
  return legacy ? [app, legacy] : [app]
}

const VALUES = new Set<string>(['allow', 'ask', 'deny'])

/** The first stored choice for this app, preferring the app key over the legacy tool key. */
export function appPermissionValue(
  permissions: Record<string, unknown> | null | undefined,
  app: string,
): AppPermissionValue | undefined {
  if (!permissions) return undefined
  for (const key of appPermissionKeys(app)) {
    const value = permissions[key]
    if (typeof value === 'string' && VALUES.has(value)) return value as AppPermissionValue
  }
  return undefined
}

/** `ask` is allowed where no approval card exists (GitHub); only an explicit deny withholds. */
export function appCallAllowed(value: AppPermissionValue | null | undefined): boolean {
  return value !== 'deny'
}

/** The app's stored choice, set on both keys, or removed from both. */
export function withAppPermission(
  permissions: Record<string, AppPermissionValue>,
  app: string,
  value: AppPermissionValue | null,
): Record<string, AppPermissionValue> {
  const next = { ...permissions }
  for (const key of appPermissionKeys(app)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}
