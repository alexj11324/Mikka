import { WRITE_TOOL_APPS } from '@/lib/app-policy/apps'

/** The first-class mail and calendar writes (lib/composio-actions), and the app each one writes to. */
export const APPROVAL_WRITE_ACTIONS: Readonly<Record<string, string>> = {
  send_email: 'gmail',
  create_calendar_event: 'googlecalendar',
  update_calendar_event: 'googlecalendar',
}

// One app-level permission key, with the first-class write tools that act in
// the same app. A settings page writes both so the app-level choice governs
// generic app tools and the older write paths together. The team-permission
// map is the app policy's own (`WRITE_TOOL_APPS`), extended with the mail and
// calendar writes, so a new first-class write action cannot leave the workspace
// page silently unable to govern it.
export const LEGACY_WRITE_ACTIONS: Readonly<Record<string, string>> = { ...WRITE_TOOL_APPS, ...APPROVAL_WRITE_ACTIONS }

export const LEGACY_APP_ACTIONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEGACY_WRITE_ACTIONS).map(([action, app]) => [app, action]),
)

export type AppPermissionValue = 'allow' | 'ask' | 'deny'

/** The keys that carry one app's choice: the app itself, then every first-class write tool in it. */
export function appPermissionKeys(app: string): string[] {
  return [...new Set([app, ...Object.entries(LEGACY_WRITE_ACTIONS).filter(([, value]) => value === app).map(([action]) => action)])]
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

/** The setting keys one app tool call consults: its own slug, its app key and its legacy action. */
export function appCallSettingKeys(toolSlug: string, toolkit: string): string[] {
  return [...new Set([toolSlug, ...appPermissionKeys(toolkit)])]
}

/** One save applies the same choice to every selected app, each on both keys. */
export function withAppPermissions(
  permissions: Record<string, AppPermissionValue>,
  apps: readonly string[],
  value: AppPermissionValue | null,
): Record<string, AppPermissionValue> {
  return apps.reduce((next, app) => withAppPermission(next, app, value), permissions)
}
