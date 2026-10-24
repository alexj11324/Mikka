// BYOS routing metadata, never provider credentials. This is independent of
// both the execution harness and the computer a run's tools operate (#172).
import { z } from "zod"

import { quotaSnapshotSchema, type QuotaSnapshot } from "./quota"

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

export class SubscriptionRefusal extends Error {
  constructor(readonly code: SubscriptionRefusalCode) {
    super(code)
    this.name = "SubscriptionRefusal"
  }
}

export interface SubscriptionAccess {
  binding: SubscriptionBinding | null
  connection: SubscriptionConnection | null
  backend: SubscriptionBackend | null
  // Trusted durable-operation metadata, never accepted from browser assertions.
  credentialTransition?: 'refreshing' | 'publication_pending'
}

// Unknown, stale, wrong-vendor or empty usage is not evidence of free capacity.
// Use existing daemon readers' numbers; this helper never reads credentials.
export function subscriptionQuotaState(
  quota: QuotaSnapshot,
  route: SubscriptionRoute,
  now: number,
): "available" | "unknown" | "exhausted" {
  const vendor =
    SUBSCRIPTION_ROUTES[route].provider === "openai" ? "codex" : "claude_code"
  const observed = Date.parse(quota.observedAt)
  if (
    quota.vendor !== vendor ||
    quota.status !== "ok" ||
    !quota.windows.length ||
    quota.windows.some(
      (window) =>
        window.meter === "api" ||
        window.meter === "on_demand" ||
        window.meter === "team_on_demand",
    ) ||
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > 60_000
  )
    return "unknown"
  // Conservatively block on any reported exhausted window. A reset needs a
  // fresh provider observation; a local clock must not manufacture capacity.
  if (quota.windows.some((window) => window.used >= 1)) return "exhausted"
  return "available"
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
  if (
    !connection ||
    binding.ownerId !== use.ownerId ||
    connection.ownerId !== use.ownerId ||
    binding.workspaceId !== use.workspaceId ||
    connection.workspaceId !== use.workspaceId
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
    backend.workspaceId !== use.workspaceId ||
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
  const quota = subscriptionQuotaState(connection.quota, binding.route, now)
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
