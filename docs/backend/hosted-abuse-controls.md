# Hosted-model abuse controls (#523, #525, #526, #527)

The corrections in the issue comments are authoritative: cloud computers are
BYO E2B only; there is no platform E2B pool or plan bucket to meter. Card
verification grants exactly USD 1 once, not a periodically renewed credit.

## Backend contract for the frontend

- `startCardVerification(workspaceId?)` is admin-only and returns a Stripe
  SetupIntent `clientSecret` and `paymentElementOptions` with the authenticated
  user’s email prefilled for Link. Use Stripe.js to confirm the setup. There is no
  amount, charge, subscription, or automatic top-up. Bank authorization holds
  can still appear. The existing signature-checked webhook handles
  `setup_intent.succeeded`; the frontend must not grant credit itself.
- `getHostedUsage(workspaceId?)` returns `state`, `balance`, and up to 50 recent
  calls (recent calls are admin-only; members receive balance/state). Amounts are integer microdollars (USD 1 = 1,000,000); purchased points
  convert at 100 points per dollar. The existing admin `workspaceUsage` read
  also exposes the hosted balance and state. Member usage remains scoped to
  their own bots.
- States: `ready`, `verification_required`, `free_allowance_used`,
  `platform_paused`, `usage_in_progress`, `usage_cost_unavailable`. Model
  execution errors carry the stable code as their message/code, including
  Coordinator failure records. A purchase qualifies as verification even
  after the purchased balance has been consumed.
- The signup and verification-mail requests must send a fresh Turnstile token
  in `x-turnstile-token` (or `turnstileToken` in the request body). Keys are
  `TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, already set by
  Claude. No secret is returned by these APIs. OAuth does not require Turnstile.
- Missing Turnstile secret in Vercel production fails with
  `SIGNUP_VERIFICATION_UNAVAILABLE` and an error log. Local/preview deployments
  without keys skip verification. Invalid/missing tokens use
  `TURNSTILE_INVALID` / `TURNSTILE_REQUIRED`.
- Signup errors also include `DISPOSABLE_EMAIL`, `EMAIL_ALREADY_REGISTERED`,
  `SIGNUP_RATE_LIMITED`. Original email addresses remain unchanged. The
  normalized uniqueness claim is enforced by a database trigger, including
  concurrent signup and email changes. Existing aliases are not removed.

No React components, checkout screens, widgets, or state UI are implemented
in this PR. Those remain with Claude. Production email signup/resend needs
Claude's token-sending frontend; enabling the backend intentionally refuses
requests without that proof.

## Scope and accounting

All new Gateway text calls are admitted before provider I/O. Default Workflow
turns (Coordinator/bot and Slack), frozen hosted snapshots, live evaluations,
compaction, group replies, action-title generation and profile extraction use
the metered model seam. Triage, group routing/correction, and notification
attention decisions carry the server-owned workspace billing context.
Subscription-model snapshots retain their existing model seam and never debit
hosted credit. Own-device work and BYO E2B do not require a card or debit points.
Unscoped internal decision transport is exempt for the host's own judgments;
it retains the separate existing `DECISION_GATEWAY_API_KEY` provider budget.
The standalone `routeGroupMessage`/`callDecisionRequest` helpers have no active
unscoped user-facing consumer in this revision.

`claimCloudRun` does not create an E2B sandbox. All sandbox create/connect
paths (`lib/computer/e2b-provider.ts`, thread machines and desktop access) now
resolve a workspace-owned key. There is no remaining production read of the
platform `E2B_API_KEY` for sandbox provisioning. Missing keys retain the existing
`e2b_key_missing` code; changing the old BYO flag cannot restore the fallback.

Card claims, verification, the free allowance and `billing.card_verified` audit
commit in one transaction. Claims have no workspace FK and survive deletion.
The workspace database migration snapshots existing workspace IDs once; lazy
application-database initialization marks these verified and gives the same
bounded USD 1 starting allowance without asking existing users to bind a card.
Replaying the migration does not grandfather later workspaces.

Free credit is spent before purchased points; `plan` grants are ignored.
One pending/unknown call per workspace bounds concurrent overdraft to the one
current call, including across processes. Each provider invocation has its own
ledger ID; settlement is idempotent. Workflow retries cannot silently replay a
pending call. A call can finish its current step beyond the remaining balance;
its entire cost remains in the ledger as debt rather than disappearing.

The text model caps output at 4,096 tokens and provider time at 60 seconds;
compaction keeps its existing 30-second timeout. It reserves a conservative
cost from Gateway's model catalog before calling. Inputs over 16 MB or missing model pricing are refused with
`usage_cost_unavailable`; inline file/image inputs include a conservative
128,000-token cushion per part in the reservation. Subscription calls keep
their existing capabilities.
Actual Gateway `providerMetadata.gateway.cost` is rounded upwards to integer
microdollars. Missing cost or an interrupted provider call retains its
reservation and blocks further workspace calls, rather than treating unknown
usage as free. Operators can reconcile the same call ID with
`HostedUsageStore.settle(id, actualMicroUsd, ...)` after checking the Gateway
receipt. No automatic retry discards an uncertain charge.

## Platform breaker and alerts

The default rolling 24-hour free-model budget is USD 25. An admission lock
serializes free-budget checks and reservations; no database lock spans model
network I/O. Pending reservations count toward the cap. The pause clears as
usage leaves the rolling window. Purchased usage can proceed while free use is
paused; in that case the free allowance is left untouched. Unpaid overruns of
the current free-funded call are included in the platform spend total.

- `MIKKA_FREE_MODEL_DAILY_CENTS`: positive integer, default 2500.
- `MIKKA_FREE_MODEL_FIRST_USE_HOURLY`: positive integer, default 50.
- Invalid, zero, negative or unlimited-like values fall back to the defaults.
- 50%/100% spend and first-use spikes are durably deduplicated and logged;
  delivery uses the existing Resend API and sender. Default recipient is the
  existing operations/contact inbox `mikka@aspectlylabs.com`; override with
  `MIKKA_ABUSE_ALERT_EMAIL`. Missing/failed delivery remains pending for the
  next usage check. No real alert mail is sent by tests.

Signup and verification-mail fixed-hour limits reuse Better Auth's database
`rateLimit` table. Signup: 5/IP and 100 globally; mail: 15/IP and 300 globally;
normalized address: 3/hour for each operation. Global counters are locked before
IP/address counters. Vercel's overwritten forwarding header supplies the IP;
local requests share a local bucket. Finite quota overrides are
`MIKKA_SIGNUP_IP_HOURLY`, `MIKKA_SIGNUP_GLOBAL_HOURLY`,
`MIKKA_VERIFICATION_IP_HOURLY`, `MIKKA_VERIFICATION_GLOBAL_HOURLY`; invalid
values fall back to the defaults. Ephemeral CI sets higher finite quotas
because all automatic test identities share loopback. The disposable-domain list is vendored
with its CC0 license and update instructions. Optional GitHub account-age
rejection is deliberately omitted: OAuth's existing verified-email path stays
unchanged.

## Verification

`test:abuse` covers the policy, metered provider boundary and Stripe fixtures.
`test:abuse-db` uses an isolated local PostgreSQL schema, actual migrations,
concurrent card/admission/settlement calls, rolling-window behavior and signup
uniqueness/rate limits. It is registered in the required DB inventory.
Tests never use a production database, create a live Stripe charge or start an
E2B sandbox. Required PR CI supplies the production build, full functionality
and integration-branch performance acceptance.

## Link

Mikka’s live account was checked read-only through the Stripe plugin: Link is
available and enabled in both its direct default and app-associated default
payment-method configurations. No merchant settings were changed and no live
SetupIntent or charge was created for this check.

This integration intentionally uses [Link within a card integration](https://docs.stripe.com/payments/link/link-payment-integrations?link-integrations=link-card-integrations):
`allowed_payment_method_types: ['card']`. Do not add `'link'` to that list;
Stripe then represents Link as a separate opaque payment method instead of
returning the underlying card details. A Link-saved card comes back as
`PaymentMethod.type=card`, `card.wallet.type=link`; its `card.fingerprint` uses
the same database claim as manual card entry. It grants no second allowance.

For Claude’s Payment Element screen:

```ts
const { clientSecret, paymentElementOptions } = result.data
const elements = stripe.elements({ clientSecret })
const payment = elements.create('payment', paymentElementOptions)
payment.mount(container)
// On submit: await elements.submit(); then stripe.confirmSetup({
//   elements, confirmParams: { return_url: sameOriginReturnUrl },
//   redirect: 'if_required',
// })
```

Link uses the email prefill to offer authentication and saved payment details.
Stripe handles SMS/email authentication and any bank-required authentication;
Mikka never reads the code. Display depends on Stripe eligibility and the
customer’s browser/session. A successful Link login alone never grants credit:
the verified SetupIntent webhook remains the only grant path. These are backend
contracts and integration examples; the React screen remains with Claude.

References: [Link setup and reuse](https://docs.stripe.com/payments/link/save-and-reuse),
[Link integration types](https://docs.stripe.com/payments/link/link-payment-integrations).
