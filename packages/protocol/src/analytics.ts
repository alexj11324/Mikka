// Product analytics catalog (ADR 0033, docs/analytics.md). Every client
// (desktop, phone app) captures only these events with only these property
// keys, so nothing a person typed, no code, no path and no name can reach
// PostHog by accident. Adding an event or a key is a change to this file.

/** Keys every client adds to every event itself; callers never pass them. */
export const ANALYTICS_CONTEXT_KEYS = [
  "flavor",
  "version",
  "runtime",
  "platform",
] as const

/**
 * Property keys an event may list. Values are ids, versions, enum-like words
 * or numbers: `sanitizeProperties` drops anything that looks like text.
 */
export const ANALYTICS_PROPERTY_KEYS = [
  ...ANALYTICS_CONTEXT_KEYS,
  /** UI language preference, e.g. `zh-CN`. */
  "language",
  /** Agent harness id: `claude_code`, `codex`, `cursor`, `mock`. */
  "harness",
  /** Login provider: `github`, `google`, `dev`. */
  "provider",
  /** How something ended: `completed`, `failed`, `cancelled`, ... */
  "outcome",
  /** Where the action started: `ui`, `keyboard`, `command_menu`, `chat`, `agent`. */
  "source",
  /** Answer to a permission card: `allow`, `deny`, `always`. */
  "decision",
  /** Which field of an object changed: `status`, `priority`, `assignee`, ... */
  "field",
  /** Which setting changed, with `value` its new enum value. */
  "setting",
  "value",
  /** Route name without ids: `board`, `issue`, `settings_devices`. */
  "screen",
  /** A short error or failure code, never a message. */
  "reason",
  /** An issue status: `backlog`, `todo`, `in_progress`, `in_review`, `done`. */
  "status",
  /** A count, e.g. how many items an action touched. */
  "count",
] as const
export type AnalyticsPropertyKey = (typeof ANALYTICS_PROPERTY_KEYS)[number]

type ContextKey = (typeof ANALYTICS_CONTEXT_KEYS)[number]

/**
 * The event catalog: each event and the property keys it may carry.
 * Names are `object_action` in past tense, snake_case (docs/analytics.md).
 */
export const ANALYTICS_CATALOG = {
  // App shell
  app_opened: ["language"],
  screen_viewed: ["screen"],
  command_menu_opened: [],
  search_used: [],
  update_required: [],
  error_shown: ["screen", "reason"],
  setting_changed: ["setting", "value"],

  // Sign-in
  sign_in_started: ["provider"],
  signed_in: ["provider"],
  sign_in_failed: ["provider", "reason"],
  signed_out: [],

  // Devices and repositories
  device_linked: [],
  device_link_failed: ["reason"],
  repo_added: [],
  repo_removed: [],

  // Agents
  agent_created: ["harness"],
  agent_updated: ["harness", "field"],
  agent_archived: ["harness"],
  agent_policy_changed: ["harness", "field"],
  /** A person's own agent preferences (ADR 0060). */
  agent_preference_changed: ["field"],

  // Issues
  issue_created: ["source", "status"],
  issue_updated: ["field", "source"],
  issue_status_changed: ["status", "source"],
  issue_deleted: ["source"],
  issue_delegated: ["harness", "source"],
  issue_relation_changed: ["field"],
  board_reordered: [],

  // Comments
  comment_created: ["source"],
  comment_edited: [],
  comment_deleted: [],
  comment_resolved: [],

  // Chats and runs
  chat_started: ["harness", "source"],
  chat_message_sent: ["harness", "source"],
  run_started: ["harness", "source"],
  run_finished: ["harness", "outcome"],
  run_cancelled: ["harness"],
  run_resumed: ["harness"],
  permission_answered: ["harness", "decision"],
  deliverable_previewed: [],

  // Review
  review_accepted: [],
  review_rejected: [],

  // Inbox
  notification_actioned: ["field"],
} as const satisfies Record<string, readonly AnalyticsPropertyKey[]>

export type AnalyticsEvent = keyof typeof ANALYTICS_CATALOG
export const ANALYTICS_EVENTS = Object.keys(
  ANALYTICS_CATALOG
) as AnalyticsEvent[]

export type AnalyticsValue = string | number | boolean

/** The properties one event may carry, from the catalog. */
export type AnalyticsProps<E extends AnalyticsEvent> = {
  [
    K in Exclude<(typeof ANALYTICS_CATALOG)[E][number], ContextKey>
  ]?: AnalyticsValue
}

export type AnalyticsProperties = Partial<
  Record<AnalyticsPropertyKey, AnalyticsValue>
>

const MAX_VALUE_LENGTH = 40
// Ids, versions and enum-like words only: no spaces, slashes or @, so a
// prompt, a file path or an email address cannot pass.
const SAFE_VALUE = /^[A-Za-z0-9_:.-]+$/

/**
 * Keeps only the allowed keys and, among string values, only ids and enum
 * words. `allowed` is an event's catalog entry plus the context keys; without
 * it every known key passes the value check.
 */
export function sanitizeProperties(
  input: Readonly<Record<string, unknown>> | undefined,
  allowed: readonly string[] = ANALYTICS_PROPERTY_KEYS
): AnalyticsProperties {
  const out: AnalyticsProperties = {}
  if (!input) return out
  for (const key of ANALYTICS_PROPERTY_KEYS) {
    if (!allowed.includes(key) || !Object.hasOwn(input, key)) continue
    const value = input[key]
    if (typeof value === "boolean" || Number.isFinite(value)) {
      out[key] = value as boolean | number
    } else if (
      typeof value === "string" &&
      value.length <= MAX_VALUE_LENGTH &&
      SAFE_VALUE.test(value)
    ) {
      out[key] = value
    }
  }
  return out
}

export function isAnalyticsEvent(name: unknown): name is AnalyticsEvent {
  return typeof name === "string" && Object.hasOwn(ANALYTICS_CATALOG, name)
}

/** What a client sends for `event`: its context plus the allowed, clean props. */
export function eventProperties<E extends AnalyticsEvent>(
  event: E,
  context: object,
  props?: Readonly<Record<string, unknown>>
): AnalyticsProperties {
  const allowed: readonly string[] = [
    ...ANALYTICS_CONTEXT_KEYS,
    ...ANALYTICS_CATALOG[event],
  ]
  // The client's context comes last so a caller cannot override it.
  return sanitizeProperties({ ...props, ...context }, allowed)
}
