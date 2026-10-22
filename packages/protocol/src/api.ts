// API keys and webhooks (ADR 0050): the contracts shared by the settings
// screen and the server, so both validate the same shapes. Secrets never sync
// through Zero: the key value and the webhook signing secret are returned once
// by the create call and stored hashed / encrypted on the server.
import { z } from "zod"

/**
 * What a key may do. `read` covers GET and HEAD, `write` everything else. The
 * key can never do more than its creator can: a guest's key stays read-only
 * whatever the scopes say.
 */
export const API_KEY_SCOPES = ["read", "write"] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

/** The key the server hands out once, e.g. `orv_2f4c...`. */
export const API_KEY_PREFIX = "orv_"

export const apiKeyCreateRequest = z.strictObject({
  workspaceId: z.uuid(),
  name: z.string().trim().min(1, "Give the key a name.").max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  /** Optional; a key without one never expires. */
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
})
export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequest>

export const apiKeyView = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The display prefix, safe to show after creation. */
  prefix: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type ApiKeyView = z.infer<typeof apiKeyView>

/** The one response that carries the full key. */
export const apiKeyCreated = apiKeyView.extend({ secret: z.string() })
export type ApiKeyCreated = z.infer<typeof apiKeyCreated>

export const apiKeyListResponse = z.object({
  keys: z.array(apiKeyView),
})
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponse>

/** Events a webhook may subscribe to; payloads carry ids only (ADR 0033). */
export const WEBHOOK_EVENTS = [
  "issue.created",
  "issue.updated",
  "comment.created",
  "run.completed",
  "run.failed",
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** `http` only for local development; production requires https. */
export const webhookUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//.test(value), "Use an http(s) webhook URL.")

export const webhookCreateRequest = z.strictObject({
  workspaceId: z.uuid(),
  url: webhookUrlSchema,
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  enabled: z.boolean().optional(),
})
export type WebhookCreateRequest = z.infer<typeof webhookCreateRequest>

export const webhookUpdateRequest = z.strictObject({
  url: webhookUrlSchema.optional(),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1)
    .max(WEBHOOK_EVENTS.length)
    .optional(),
  enabled: z.boolean().optional(),
})
export type WebhookUpdateRequest = z.infer<typeof webhookUpdateRequest>

export const webhookView = z.object({
  id: z.uuid(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  enabled: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type WebhookView = z.infer<typeof webhookView>

/** The only response that carries the signing secret. */
export const webhookCreated = webhookView.extend({ secret: z.string() })
export type WebhookCreated = z.infer<typeof webhookCreated>

export const webhookListResponse = z.object({
  webhooks: z.array(webhookView),
})
export type WebhookListResponse = z.infer<typeof webhookListResponse>

export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
] as const
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number]

export const webhookDeliveryView = z.object({
  id: z.uuid(),
  event: z.enum(WEBHOOK_EVENTS),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  /** How many attempts have been made; capped on the server. */
  attempts: z.number().int().nonnegative(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
})
export type WebhookDeliveryView = z.infer<typeof webhookDeliveryView>

export const webhookDeliveryListResponse = z.object({
  deliveries: z.array(webhookDeliveryView),
})
export type WebhookDeliveryListResponse = z.infer<
  typeof webhookDeliveryListResponse
>

/** The last delivery log entries kept per webhook (a debugging aid, not a log). */
export const WEBHOOK_DELIVERY_RETENTION = 50

/** How many times a delivery is attempted before it is marked failed. */
export const WEBHOOK_MAX_ATTEMPTS = 3

/** What every event carries: ids and enums only, never content (ADR 0033). */
export const webhookPayload = z.object({
  id: z.uuid(),
  event: z.enum(WEBHOOK_EVENTS),
  workspaceId: z.uuid(),
  issueId: z.uuid().nullable().optional(),
  commentId: z.uuid().nullable().optional(),
  runId: z.uuid().nullable().optional(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type WebhookPayload = z.infer<typeof webhookPayload>

/** What the settings screen calls; a signed-in person, not an API key. */
export const API_KEY_ROUTES = {
  list: "/v1/api-keys",
  create: "/v1/api-keys",
  revoke: "/v1/api-keys/:id",
} as const

export const WEBHOOK_ROUTES = {
  list: "/v1/webhooks",
  create: "/v1/webhooks",
  update: "/v1/webhooks/:id",
  remove: "/v1/webhooks/:id",
  deliveries: "/v1/webhooks/:id/deliveries",
  retry: "/v1/webhooks/:id/deliveries/:deliveryId/retry",
} as const

/** The key-authenticated read API scripts and CI call. */
export const PUBLIC_API_ROUTES = {
  me: "/v1/api/me",
  issues: "/v1/api/issues",
} as const

export const publicApiMe = z.object({
  user: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
  }),
  workspace: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
  }),
  role: z.enum(["owner", "admin", "member", "guest"]),
  key: z.object({
    id: z.uuid(),
    name: z.string(),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
  }),
})
export type PublicApiMe = z.infer<typeof publicApiMe>

export const publicApiIssue = z.object({
  id: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  status: z.string(),
  priority: z.number().int(),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type PublicApiIssue = z.infer<typeof publicApiIssue>

export const publicApiIssueList = z.object({
  issues: z.array(publicApiIssue),
})
export type PublicApiIssueList = z.infer<typeof publicApiIssueList>
