import { describe, expect, it } from "vitest"

import {
  subscriptionFixture,
  SUBSCRIPTION_TEST_NOW as NOW,
} from "../../../tests/fixtures/subscription"
import {
  authorizeSubscriptionUse,
  invalidateSubscriptionConnection,
  subscriptionBindingSchema,
  subscriptionConnectionSchema,
  SUBSCRIPTION_ROUTES,
  type SubscriptionAccess,
  type SubscriptionRefusalCode,
} from "./subscription"

describe("subscription policy", () => {
  it.each(
    Object.keys(SUBSCRIPTION_ROUTES) as (keyof typeof SUBSCRIPTION_ROUTES)[],
  )("routes %s only through its explicitly bound backend", (route) => {
    const { use, access } = subscriptionFixture(route)
    expect(authorizeSubscriptionUse(use, access, NOW).binding.route).toBe(route)
  })

  const refusals: [
    string,
    SubscriptionRefusalCode,
    (access: SubscriptionAccess) => void,
  ][] = [
    [
      "missing binding",
      "binding_required",
      (a) => {
        a.binding = null
      },
    ],
    [
      "missing account",
      "account_unavailable",
      (a) => {
        a.connection = null
      },
    ],
    [
      "different account owner",
      "account_unavailable",
      (a) => {
        a.connection!.ownerId = "bob"
      },
    ],
    [
      "different binding owner",
      "account_unavailable",
      (a) => {
        a.binding!.ownerId = "bob"
      },
    ],
    [
      "different workspace",
      "account_unavailable",
      (a) => {
        a.connection!.workspaceId = "workspace-b"
      },
    ],
    [
      "different consumer",
      "binding_mismatch",
      (a) => {
        a.binding!.consumerId = "bot-b"
      },
    ],
    [
      "different connection",
      "binding_mismatch",
      (a) => {
        a.binding!.connectionId = "connection-b"
      },
    ],
    [
      "different binding",
      "binding_mismatch",
      (a) => {
        a.binding!.id = "other"
      },
    ],
    [
      "different provider",
      "binding_mismatch",
      (a) => {
        a.connection!.provider = "anthropic"
      },
    ],
    [
      "different execution path",
      "binding_mismatch",
      (a) => {
        a.binding!.route = "openai_siwc"
      },
    ],
    [
      "stale binding",
      "stale_binding",
      (a) => {
        a.connection!.revision++
      },
    ],
    [
      "pending authorization",
      "pending_auth",
      (a) => {
        a.connection!.state = "pending"
      },
    ],
    [
      "revoked authorization",
      "reconnect_required",
      (a) => {
        a.connection!.state = "reconnect_required"
      },
    ],
    [
      "disconnected",
      "disconnected",
      (a) => {
        a.connection!.state = "disconnected"
      },
    ],
    [
      "backend absent",
      "backend_unavailable",
      (a) => {
        a.backend = null
      },
    ],
    [
      "backend disabled",
      "backend_unavailable",
      (a) => {
        a.backend!.readiness = "unavailable"
      },
    ],
    [
      "approval absent",
      "provider_approval_required",
      (a) => {
        a.backend!.readiness = "approval_required"
      },
    ],
    [
      "wrong backend owner",
      "binding_mismatch",
      (a) => {
        a.backend!.ownerId = "bob"
      },
    ],
    [
      "old backend revision",
      "binding_mismatch",
      (a) => {
        a.backend!.connectionRevision++
      },
    ],
    [
      "shared uid/config dirs",
      "isolation_required",
      (a) => {
        a.backend!.isolation = "none"
      },
    ],
    [
      "unverified billing",
      "billing_unverified",
      (a) => {
        a.backend!.billing = "unverified"
      },
    ],
    [
      "unknown quota",
      "quota_unknown",
      (a) => {
        a.connection!.quota.status = "unknown"
      },
    ],
    [
      "missing windows",
      "quota_unknown",
      (a) => {
        a.connection!.quota.windows = []
      },
    ],
    [
      "stale quota",
      "quota_unknown",
      (a) => {
        a.connection!.quota.observedAt = new Date(NOW - 60_001).toISOString()
      },
    ],
    [
      "future quota",
      "quota_unknown",
      (a) => {
        a.connection!.quota.observedAt = new Date(NOW + 1).toISOString()
      },
    ],
    [
      "malformed timestamp",
      "quota_unknown",
      (a) => {
        a.connection!.quota.observedAt = "broken"
      },
    ],
    [
      "wrong vendor quota",
      "quota_unknown",
      (a) => {
        a.connection!.quota.vendor = "cursor"
      },
    ],
    [
      "paid usage window",
      "quota_unknown",
      (a) => {
        a.connection!.quota.windows[0].meter = "on_demand"
      },
    ],
    [
      "exhausted quota",
      "quota_exhausted",
      (a) => {
        a.connection!.quota.windows[0].used = 1
      },
    ],
  ]
  it.each(refusals)("refuses %s", (_label, code, mutate) => {
    const { use, access } = subscriptionFixture()
    mutate(access)
    expect(() => authorizeSubscriptionUse(use, access, NOW)).toThrow(code)
  })

  it.each(["codex_cpa", "claude_cpa", "openai_siwc"] as const)(
    "keeps hosted %s approval-gated without a registered eligible backend",
    (route) => {
      const { use, access } = subscriptionFixture(route)
      access.backend = null
      expect(() => authorizeSubscriptionUse(use, access, NOW)).toThrow(
        "provider_approval_required",
      )
    },
  )

  it("invalidates quota and old bindings on reconnect and disconnect", () => {
    const { use, access } = subscriptionFixture()
    for (const state of ["reconnect_required", "disconnected"] as const) {
      access.connection = invalidateSubscriptionConnection(
        access.connection!,
        state,
      )
      expect(access.connection.quota).toMatchObject({
        status: "unknown",
        windows: [],
        plan: null,
      })
      // Signing back in does not silently restore old grants.
      access.connection.state = "connected"
      expect(() => authorizeSubscriptionUse(use, access, NOW)).toThrow(
        "stale_binding",
      )
    }
  })

  it("uses credential-free strict wire contracts", () => {
    const { access } = subscriptionFixture()
    expect(
      subscriptionConnectionSchema.safeParse({
        ...access.connection,
        accessToken: "dummy",
      }).success,
    ).toBe(false)
    expect(
      subscriptionBindingSchema.safeParse({
        ...access.binding,
        endpoint: "https://untrusted.invalid",
      }).success,
    ).toBe(false)
    expect(subscriptionConnectionSchema.parse(access.connection)).toEqual(
      access.connection,
    )
  })
})
