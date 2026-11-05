// BYOS routing metadata, never provider credentials. This is independent of
// both the execution harness and the computer a run's tools operate (#172).
import { z } from "zod"

import { CodedError, type CodedErrorOptions } from "./coded-error"
import { quotaSnapshotSchema, type QuotaSnapshot, type QuotaWindow } from "./quota"

const id = z.string().min(1).max(128)
export const subscriptionRouteSchema = z.enum([
  "codex_cli",
  "claude_code_cli",
  "codex_cpa",
  "claude_cpa",
  "openai_siwc",
])
export type SubscriptionRoute = z.infer<typeof subscriptionRouteSchema>

export const SUBSCRIPTION_ROUTES = {
  codex_cli: {
    provider: "openai",
    execution: "native",
    eligibility: "documented",
  },
  claude_code_cli: {
    provider: "anthropic",
    execution: "native",
    eligibility: "documented",
  },
  // CPA acquisition/proxy routes are required product capabilities. Provider
  // eligibility and a reviewed executor without identity cloaking are gates.
  codex_cpa: {
    provider: "openai",
    execution: "model",
    eligibility: "approval_required",
  },
  claude_cpa: {
    provider: "anthropic",
    execution: "model",
    eligibility: "approval_required",
  },
  // SIWC documents OSS/local apps; Mikka's hosted offering needs admission.
  openai_siwc: {
    provider: "openai",
    execution: "model",
    eligibility: "approval_required",
  },
} as const

export const subscriptionConnectionSchema = z
  .object({
    id,
    ownerId: id,
    workspaceId: id,
    provider: z.enum(["openai", "anthropic"]),
    state: z.enum([
      "pending",
      "connected",
      "reconnect_required",
      "disconnected",
    ]),
    // Increment on reconnect/disconnect. Old bindings cannot become valid again.
    revision: z.number().int().positive(),
    quota: quotaSnapshotSchema,
  })
  .strict()
export type SubscriptionConnection = z.infer<
  typeof subscriptionConnectionSchema
>

export const subscriptionBindingSchema = z
  .object({
    id,
    ownerId: id,
    workspaceId: id,
    // An agent or assistant session selected explicitly by the owner.
    consumerId: id,
    connectionId: id,
    connectionRevision: z.number().int().positive(),
    route: subscriptionRouteSchema,
  })
  .strict()
export type SubscriptionBinding = z.infer<typeof subscriptionBindingSchema>

export interface SubscriptionUse {
  // Must come from the authenticated session and authorized run, not the body.
  ownerId: string
  workspaceId: string
  consumerId: string
  bindingId: string
  execution: "native" | "model"
  /** Server-derived run ledger ID, never chosen by the model. */
  runId?: string
}

export const nativeBrokerContextSchema = z.object({
  route: z.enum(['codex_cli', 'claude_code_cli']),
  modelId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  accountId: z.string().min(1).max(512),
  plan: z.string().max(40).optional(),
  expiresAt: z.iso.datetime(),
}).strict()
export type NativeBrokerContext = z.infer<typeof nativeBrokerContextSchema>
/**
 * One device run's short-lived access lease (orchestration.md §6): the
 * access token only, never a refresh grant. The daemon asks again before
 * `expiresAt`; each request is checked anew.
 */
export const nativeLeaseSchema = nativeBrokerContextSchema.extend({
  accessToken: z.string().min(1).max(32768).regex(/^[^\r\n\0]+$/),
}).strict()
export type NativeLease = z.infer<typeof nativeLeaseSchema>
export interface NativeBrokerRequest { path: string; headers: Record<string,string>; body: unknown }

/** A trusted backend's account boundary, never an attestation from a browser. */
export interface SubscriptionBackend {
  connectionId: string
  connectionRevision: number
  ownerId: string
  workspaceId: string
  route: SubscriptionRoute
  // A runtime boundary verified by the runner; the final E2B topology is still
  // subject to security/cost review. Different config dirs alone never qualify.
  isolation: "verified_runtime" | "credential_broker" | "none"
  billing: "subscription_only" | "unverified"
  readiness: "unavailable" | "approval_required" | "ready"
}

export type SubscriptionRefusalCode =
  | "binding_required"
  | "account_unavailable"
  | "binding_mismatch"
  | "stale_binding"
  | "pending_auth"
  | "reconnect_required"
  | "disconnected"
  | "quota_unknown"
  | "quota_exhausted"
  | "provider_approval_required"
  | "backend_unavailable"
  | "isolation_required"
  | "billing_unverified"

export class SubscriptionRefusal extends CodedError<SubscriptionRefusalCode> {
  constructor(code: SubscriptionRefusalCode, options?: CodedErrorOptions) {
    super(code, options)
    this.name = "SubscriptionRefusal"
  }
}

export interface SubscriptionAccess {
  binding: SubscriptionBinding | null
  connection: SubscriptionConnection | null
  backend: SubscriptionBackend | null
  /** Actual model chosen by the trusted backend; absent while a native CLI's choice is unknown. */
  modelId?: string
  // Trusted durable-operation metadata, never accepted from browser assertions.
  credentialTransition?: 'refreshing' | 'publication_pending'
}

const normalizeQuotaModel = (value: string) => value.trim().toLowerCase().replace(/[ ._]+/g, '-').replace(/-+/g, '-')

/** A scope may be irrelevant, applicable, or not yet identified. Unknown
 * provider labels are never silently treated as unrelated models. */
export function subscriptionQuotaScope(window: Pick<QuotaWindow, 'model'>, modelId?: string): 'applicable' | 'irrelevant' | 'unknown' {
  if (!window.model) return 'applicable'
  if (!modelId) return 'unknown'
  const scope = normalizeQuotaModel(window.model)
  const model = normalizeQuotaModel(modelId)
  const scopedClaude = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+(?:-\d+)*))?$/.exec(scope)
  if (scopedClaude) {
    const chosenClaude = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-|$)/.exec(model)
    if (!chosenClaude) return 'unknown'
    if (scopedClaude[1] !== chosenClaude[1]) return 'irrelevant'
    if (!scopedClaude[2]) return 'applicable'
    if (!/^(?:claude-)?(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*$/.test(model)) return 'unknown'
    const selected = model.replace(/^claude-/, '')
    const scoped = scope.replace(/^claude-/, '')
    return selected === scoped || (selected.startsWith(`${scoped}-`) && /^\d{8}$/.test(selected.slice(scoped.length + 1))) ? 'applicable' : 'irrelevant'
  }
  if (/^(?:gpt-\d|o\d)[a-z0-9-]*$/.test(scope)) {
    if (!/^(?:gpt-\d|o\d)[a-z0-9-]*$/.test(model)) return 'unknown'
    return model === scope ? 'applicable' : 'irrelevant'
  }
  return 'unknown'
}

// Unknown, stale, wrong-vendor or empty usage is not evidence of free capacity.
// Use existing daemon readers' numbers; this helper never reads credentials.
export function subscriptionQuotaState(
  quota: QuotaSnapshot,
  route: SubscriptionRoute,
  now: number,
  modelId?: string,
): "available" | "unknown" | "exhausted" {
  const vendor =
    SUBSCRIPTION_ROUTES[route].provider === "openai" ? "codex" : "claude_code"
  const observed = Date.parse(quota.observedAt)
  if (
    quota.vendor !== vendor ||
    quota.status !== "ok" ||
    !quota.windows.length ||
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > 60_000
  )
    return "unknown"
  let applicable = false, uncertain = false, exhausted = false
  for (const window of quota.windows) {
    if (!Number.isFinite(window.used) || window.used < 0 || window.used > 1) return 'unknown'
    const scope = subscriptionQuotaScope(window, modelId)
    if (scope === 'irrelevant') continue
    const paid = window.meter === 'api' || window.meter === 'on_demand' || window.meter === 'team_on_demand'
    if (paid) { uncertain = true; continue }
    if (scope === 'unknown') { if (window.used >= 1) uncertain = true; continue }
    applicable = true
    if (window.used >= 1) {
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN
      // Crossing a reset since the last observation requires another provider
      // read; a local clock cannot manufacture fresh quota.
      if (Number.isFinite(reset) && observed < reset && reset <= now) uncertain = true
      else exhausted = true
    }
  }
  return exhausted ? 'exhausted' : uncertain || !applicable ? 'unknown' : 'available'
}

/** Re-read access for every new turn; no selection, pooling, retry or paid fallback. */
export function authorizeSubscriptionUse(
  use: SubscriptionUse,
  access: SubscriptionAccess,
  now = Date.now(),
): {
  binding: SubscriptionBinding
  connection: SubscriptionConnection
  backend: SubscriptionBackend
} {
  const { binding, connection, backend } = access
  const refuse = (code: SubscriptionRefusalCode): never => {
    throw new SubscriptionRefusal(code)
  }
  if (!binding) return refuse("binding_required")
  // The binding is made in the workspace it is used in; the connection keeps the
  // workspace it was connected in. An owner's subscription serves them in every
  // workspace (decision 2026-11-01-2240); the server checks membership and
  // 分享给团队成员 before access is read.
  if (
    !connection ||
    binding.ownerId !== use.ownerId ||
    connection.ownerId !== use.ownerId ||
    binding.workspaceId !== use.workspaceId
  )
    return refuse("account_unavailable")
  if (
    binding.id !== use.bindingId ||
    binding.consumerId !== use.consumerId ||
    binding.connectionId !== connection.id ||
    SUBSCRIPTION_ROUTES[binding.route].provider !== connection.provider ||
    SUBSCRIPTION_ROUTES[binding.route].execution !== use.execution
  )
    return refuse("binding_mismatch")
  if (connection.state === "disconnected") return refuse("disconnected")
  if (connection.state === "reconnect_required")
    return refuse("reconnect_required")
  if (connection.state === "pending") return refuse("pending_auth")
  if (binding.connectionRevision !== connection.revision)
    return refuse("stale_binding")
  if (
    SUBSCRIPTION_ROUTES[binding.route].eligibility === "approval_required" &&
    backend?.readiness !== "ready"
  )
    return refuse("provider_approval_required")
  if (!backend || backend.readiness === "unavailable")
    return refuse("backend_unavailable")
  if (backend.readiness === "approval_required")
    return refuse("provider_approval_required")
  if (
    backend.connectionId !== connection.id ||
    backend.connectionRevision !== connection.revision ||
    backend.ownerId !== use.ownerId ||
    backend.workspaceId !== connection.workspaceId ||
    backend.route !== binding.route
  )
    return refuse("binding_mismatch")
  if (
    backend.isolation !==
    (use.execution === "native" ? "verified_runtime" : "credential_broker")
  )
    return refuse("isolation_required")
  if (backend.billing !== "subscription_only")
    return refuse("billing_unverified")
  const quota = subscriptionQuotaState(connection.quota, binding.route, now, access.modelId)
  if (quota === "unknown") return refuse("quota_unknown")
  if (quota === "exhausted") return refuse("quota_exhausted")
  return { binding, connection, backend }
}

/** Fences Mikka use. Credential deletion and provider revocation have separately reported states. */
export function invalidateSubscriptionConnection(
  connection: SubscriptionConnection,
  state: "reconnect_required" | "disconnected",
): SubscriptionConnection {
  return {
    ...connection,
    state,
    revision: connection.revision + 1,
    quota: { ...connection.quota, status: "unknown", windows: [], plan: null },
  }
}
