// The client-side core of product analytics (ADR 0033). It has no SDK
// dependency: the desktop renderer and the phone app each hand it their
// PostHog client, so both send the same events the same way.
import {
  eventProperties,
  type AnalyticsEvent,
  type AnalyticsProps,
} from "./analytics"
import type { AuthState } from "./bridge"
import type { FeatureFlag } from "./flags"

/** The slice of a PostHog client this core uses; tests pass a fake. */
export interface AnalyticsClient {
  capture(event: string, properties?: Record<string, unknown>): void
  identify(distinctId: string): void
  reset(): void
  /** `captureEventName: false` skips PostHog's own `$opt_in` event. */
  opt_in_capturing(options?: { captureEventName?: string | false | null }): void
  opt_out_capturing(): void
  /** Current value of a flag, undefined until flags have loaded. */
  isFeatureEnabled?(key: string): boolean | undefined
  /** Calls back when flags load or change; returns an unsubscribe. */
  onFeatureFlags?(callback: () => void): () => void
}

export interface Analytics {
  track<E extends AnalyticsEvent>(event: E, props?: AnalyticsProps<E>): void
  setEnabled(enabled: boolean): void
  /**
   * Ties events to the account id (never email or name), resets on sign-out
   * and reports the sign-in funnel: `sign_in_started`, `signed_in`,
   * `sign_in_failed`, `signed_out`, `update_required`.
   */
  onAuthState(state: AuthState): void
  /** Off without a client or a loaded value, unless the build forces it on. */
  isFlagEnabled(flag: FeatureFlag): boolean
  /** For `useSyncExternalStore`; returns the unsubscribe. */
  subscribeFlags(listener: () => void): () => void
}

/** Context sent with every event; fixed per build. */
export interface AnalyticsContext {
  flavor: string
  version: string
  runtime: string
  platform?: string
}

const OPT_IN = { captureEventName: false } as const

export function createAnalytics(
  client: AnalyticsClient | null,
  context: AnalyticsContext,
  enabled: boolean,
  forcedFlags: readonly FeatureFlag[] = []
): Analytics {
  let on = enabled
  let identified: string | null = null
  let lastStatus: AuthState["status"] | null = null
  let provider: string | undefined
  if (client) {
    if (on) client.opt_in_capturing(OPT_IN)
    else client.opt_out_capturing()
  }
  const track: Analytics["track"] = (event, props) => {
    if (!client || !on) return
    client.capture(event, eventProperties(event, context, props))
  }
  return {
    track,
    setEnabled(next) {
      on = next
      if (!client) return
      if (next) client.opt_in_capturing(OPT_IN)
      else {
        client.opt_out_capturing()
        client.reset()
        identified = null
      }
    },
    onAuthState(state) {
      const previous = lastStatus
      lastStatus = state.status
      if (state.status === "signing_in") provider = state.provider
      if (!client || !on) return
      switch (state.status) {
        case "signing_in":
          if (previous !== "signing_in") track("sign_in_started", { provider })
          break
        case "signed_in":
          if (identified === state.user.id) return
          client.identify(state.user.id)
          identified = state.user.id
          // A session restored at launch is not a sign-in; app_opened covers it.
          if (previous === "signing_in") track("signed_in", { provider })
          break
        case "signed_out":
          if (identified) {
            track("signed_out")
            client.reset()
            identified = null
          }
          break
        case "error":
          if (previous === "signing_in")
            track("sign_in_failed", { provider, reason: state.code })
          break
        case "update_required":
          track("update_required")
          break
      }
    },
    isFlagEnabled(flag) {
      if (forcedFlags.includes(flag)) return true
      return client?.isFeatureEnabled?.(flag) === true
    },
    subscribeFlags(listener) {
      return client?.onFeatureFlags?.(listener) ?? (() => {})
    },
  }
}
