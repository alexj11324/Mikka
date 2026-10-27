import {
  authorizeSubscriptionUse,
  SubscriptionRefusal,
  type SubscriptionAccess,
  type SubscriptionUse,
} from "@mikka/protocol/subscription"

import type { AgentAdapter, AgentSession, StartOptions } from "./adapters/types"
import { buildChildEnv } from "./env"

export interface HostedSubscriptionBackend {
  access(): Promise<SubscriptionAccess>
  // The trusted E2B runner constructs the existing adapter INSIDE a verified
  // account boundary. A config directory on a shared uid is insufficient.
  adapter(): Promise<AgentAdapter>
}

/** Native-hosted seam. No sandbox provisioning or auth-cache reads here. */
export async function startSubscriptionSession(
  use: SubscriptionUse,
  options: StartOptions,
  backend: HostedSubscriptionBackend,
  clock: () => number = Date.now,
): Promise<AgentSession> {
  const check = async () =>
    authorizeSubscriptionUse(
      { ...use, execution: "native" },
      await backend.access(),
      clock(),
    )
  const { binding } = await check()
  // Resuming needs a persisted account/revision/session binding; do not inherit
  // an arbitrary local daemon session while that ledger is not implemented.
  if (options.continueSession) throw new SubscriptionRefusal("binding_mismatch")
  // Never repair a caller's polluted environment silently: a control-plane key
  // or provider API key would defeat account isolation / subscription billing.
  const clean = buildChildEnv({
    host: options.env,
    runId: options.env.MIKKA_RUN_ID === undefined ? undefined : options.runId,
  })
  if (
    Object.entries(options.env).some(([name, value]) => clean[name] !== value)
  ) {
    throw new SubscriptionRefusal("isolation_required")
  }
  const adapter = await backend.adapter()
  const expected = binding.route === "codex_cli" ? "codex" : "claude_code"
  if (adapter.harness !== expected)
    throw new SubscriptionRefusal("binding_mismatch")
  // Recheck after async runner resolution. The durable scheduler will also
  // cancel active sessions on revocation; this seam protects new interjections.
  await check()
  const session = await adapter.start(options)
  return {
    sessionId: session.sessionId,
    events: () => session.events(),
    async send(text) {
      try {
        await check()
      } catch (error) {
        await session.cancel()
        throw error
      }
      await session.send(text)
    },
    cancel: () => session.cancel(),
    ...(session.detach ? { detach: () => session.detach!() } : {}),
  }
}
