// Which Composio triggers feed the suggestions list, and which of them a
// person still lacks. Composio's catalog is read at run time instead of
// hard-coding every slug, so a renamed or added trigger is picked up; a trigger
// that needs configuration we cannot fill is skipped.

/** The triggers each toolkit subscribes, matched against Composio's catalog. */
export const TRIGGER_PATTERNS: Record<string, RegExp> = {
  gmail: /^GMAIL_NEW_GMAIL_MESSAGE$/,
  slack: /^SLACK_RECEIVE_(DIRECT_)?MESSAGE$/,
  // New pages, page edits and comments; not database schema changes.
  notion: /^NOTION_.*(PAGE|COMMENT).*(ADDED|CREATED|UPDATED|EDITED)/,
}

export interface TriggerTypeInfo { slug: string; config?: Record<string, unknown> }

/** True when the trigger's config schema names a required field without a default. */
export function needsConfig(type: TriggerTypeInfo): boolean {
  const required = Array.isArray(type.config?.required) ? type.config.required as unknown[] : []
  const properties = (type.config?.properties ?? {}) as Record<string, { default?: unknown } | undefined>
  return required.some(name => typeof name === 'string' && properties[name]?.default === undefined)
}

/** The catalog triggers to subscribe for one toolkit. */
export function triggerSlugs(toolkit: string, catalog: readonly TriggerTypeInfo[]): string[] {
  const pattern = TRIGGER_PATTERNS[toolkit]
  if (!pattern) return []
  return catalog.filter(type => pattern.test(type.slug) && !needsConfig(type)).map(type => type.slug)
}

export interface ActiveTrigger { connectedAccountId: string; triggerName: string; disabledAt: string | null }

/** The (account, trigger) pairs to create: wanted, and not already active for that account. */
export function missingTriggers(wanted: readonly { connectedAccountId: string; slug: string }[], active: readonly ActiveTrigger[]) {
  const have = new Set(active.filter(item => !item.disabledAt).map(item => `${item.connectedAccountId}:${item.triggerName}`))
  return wanted.filter(item => !have.has(`${item.connectedAccountId}:${item.slug}`))
}

/** How long a person's subscriptions count as checked. */
export const TRIGGER_CHECK_INTERVAL_MS = 60 * 60 * 1000
