# Hosted-model abuse controls (#523, #525, #526, #527)

The corrections in the issue comments are authoritative: cloud computers are
BYO E2B only; there is no platform E2B pool or plan bucket to meter. Card
verification grants exactly USD 1 once, not a periodically renewed credit.

## Backend contract for the frontend

- Card verification belongs to the person (orchestration.md § 7, C19). Any
  member may start it, from any workspace; it is always recorded on their own
  personal workspace, which gets the USD 1 once per card. 计费 offers it only in
  the personal workspace, and the chat's 验证银行卡 link only there too.
- `startCardVerification(workspaceId?)` needs membership of `workspaceId` and
  returns a Stripe Checkout `{ url }` in `mode: 'setup'`, with USD currency and
  the personal workspace's Stripe customer. Redirect the browser to that URL. The
  server builds the localized billing return URL with the application base path
  and the personal workspace:
  `?section=billing&workspace=…&verify=success&session_id={CHECKOUT_SESSION_ID}`
  or `verify=cancelled`. Setup creates no charge, subscription, or automatic
  top-up; bank authorization holds can still appear. The frontend never grants
  credit from the return parameters.
- `cardVerificationStatus(workspaceId?)` needs membership and reads the
  person's own verification (their personal workspace; a card they verified
  earlier on another workspace they own counts). It returns `status`
  (`unverified`, `pending`, `verified`, or `unavailable`), nullable `last4`,
  nullable `allowance` (`granted` or `claimed_elsewhere`), and
  `remainingAllowanceMicroUsd` / `remainingAllowancePoints`. USD 1 is 1,000,000
  microdollars or 100 points. An allowance that has been spent still reports
  `granted`; a card claimed by another workspace verifies without another gift.
  An open/completed Checkout awaiting its webhook is `pending`; an expired or
  canceled setup is `unverified`. Missing Stripe configuration is `unavailable`.
  Status reads cannot verify cards or grant credit; card fingerprints stay on
  the server.
- `getHostedUsage(workspaceId?)` returns `state`, `balance`, and up to 50 recent
  calls (recent calls are admin-only; members receive balance/state). Amounts are integer microdollars (USD 1 = 1,000,000); purchased points
  convert at 100 points per dollar. The existing admin `workspaceUsage` read
  also exposes the hosted balance and state. Member usage remains scoped to
  their own bots.
- `startPointsPurchase(workspaceId, amount)` is admin-only and returns a Stripe
  Checkout URL for one of the server-approved dollar amounts. Checkout metadata
  and line-item prices are server-owned; 100 points = USD 1. Returning to the
  settings page never grants points; only a paid, verified webhook does.
- `getCreditBilling(workspaceId?)` is admin-only and returns `balancePoints`
  and the newest 50 `transactions`. The balance includes the remaining gift
  and purchased points after settled usage and pending reservations, using the
  same calculation as hosted-call admission. It can contain fractional points.
  Each transaction has `id`, ISO `date`, `type` (`topup`, `verification`, or
  `refund`), signed `points`, signed `amountCents`, `currency`, nullable
  `stripeFeeCents`, `status` (`succeeded`), and nullable `receiptUrl`. Dollar
  charges and refunds use integer USD cents. Refunds deduct points at the same
  conversion; Stripe fees appear when supplied by Stripe. The one-time gift
  has 100 points, a zero paid amount, and no receipt; its history remains after
  spending and also includes the existing-workspace allowance. A verified card
  that has already claimed its allowance does not create a second gift row.
- States: `ready`, `verification_required`, `free_allowance_used`,
  `platform_paused`, `usage_in_progress` (a replayed call ID),
  `usage_concurrency_limit`, `usage_cost_unavailable`. Model
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

### Frontend integration (#563)

`lib/billing/verification-client.ts` connects `startCardVerification`,
`cardVerificationStatus`, `getCreditBilling`, and `startPointsPurchase` to their
real actions in `app/actions/billing.ts`. Checkout actions return `{ url }`;
there is no Payment Element client secret. Action successes are flat objects,
and failures are `{ error }`.

The points action is `startPointsPurchase(workspaceId, amount)` for USD
10 / 25 / 50. The #559 `CreditBillingView` and `CreditTransaction` field names
match #563's types. The backend's `balancePoints` can contain fractional
points; the adapter rounds down for the existing whole-point display and
preserves every transaction. The browser fixture uses no Stripe keys and
checks the real status contract: a Checkout return remains `unavailable`
even when a verified row exists, while the granted gift remains in the balance.
Source tests verify action mapping, argument forwarding, authorization errors,
and transaction preservation without Stripe calls.

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
resolve the sandbox owner's own key (`user_e2b_keys`; keys are personal). There is no remaining production read of the
platform `E2B_API_KEY` for sandbox provisioning. Missing keys retain the existing
`e2b_key_missing` code; changing the old BYO flag cannot restore the fallback.

Card claims, verification, the free allowance and `billing.card_verified` audit
commit in one transaction. Claims have no workspace FK and survive deletion.
The workspace database migration snapshots existing workspace IDs once; lazy
application-database initialization marks these verified and gives the same
bounded USD 1 starting allowance without asking existing users to bind a card.
Replaying the migration does not grandfather later workspaces.

On the existing signature-checked Stripe endpoint, retain
`setup_intent.succeeded` and existing billing subscriptions, and enable
`checkout.session.completed`. Setup sessions use their locally recorded
session/customer binding to retrieve the SetupIntent and payment method before
the existing card claim and grant transaction runs. Payment-mode sessions
continue to the billing handler for #559. Retain #559's additional
`checkout.session.async_payment_succeeded`, `charge.refunded`, and
`refund.updated` subscriptions when both changes are deployed. Receiving both
setup-completion events or replaying a session cannot grant a second allowance.

Purchases are deduplicated by Checkout session and refunds by refund ID.
Pending refunds are checked against Stripe's current state and leave the event
retryable. A later successful `refund.updated` also applies the debit, including
after the original event's retry window expires.

The user's 2026-10-31 decision supersedes the previous financial reservation
design: check the current available balance before a call and charge its actual
receipt afterwards. Any positive balance is sufficient; a model cost estimate
cannot reject it. There is no new balance freeze or prepayment. Free credit is
spent before purchased points; `plan` grants are ignored.

Calls in one workspace run concurrently (decision
`docs/design/decisions/2026-11-01-0400-hosted-calls-run-concurrently.md`).
`reserve` records a receipt ID and a hold of `HOSTED_CALL_HOLD_MICRO_USD`
(USD 0.10) on the row's `holdMicroUsd`; all reserved-money fields on new rows
are zero and the hold is never charged. A call is admitted when nothing else is
in flight and the balance is positive, or when the balance minus the holds of
pending/unknown calls covers its own hold; otherwise `free_allowance_used`. At
most `HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE` (8) pending calls run per workspace,
including across processes; beyond that, `usage_concurrency_limit`. Each
provider invocation has its own ledger ID; settlement is idempotent. Workflow
retries cannot silently replay a call (`usage_in_progress`). A call can finish
beyond the remaining balance; its entire actual cost remains in the ledger as
debt. The next call is refused until recorded purchased credit restores a
positive net balance. Debt never authorizes another call.

The text model caps output at 4,096 tokens and provider time at 60 seconds;
compaction keeps its existing 30-second timeout. Inputs over 16 MB are refused;
these transport bounds do not reserve money. Subscription calls keep their
existing capabilities.
Actual Gateway `providerMetadata.gateway.cost` is rounded upwards to integer
microdollars. Missing cost or an interrupted provider call retains its
receipt record and keeps its hold until reconciled, rather than treating unknown
usage as free. Operators can reconcile the same call ID with
`HostedUsageStore.settle(id, actualMicroUsd, ...)` after checking the Gateway
receipt. No automatic retry discards an uncertain charge.
Already existing rows with prepaid amounts retain their old accounting until
settled, so changing the admission path cannot charge or refund them twice.

## Platform breaker and alerts

The default rolling 24-hour free-model budget is USD 25. An admission lock
serializes current balance and actual-spend checks; no database lock spans model
network I/O. Calls already executing can finish beyond the cap; actual receipts
stop subsequent eligible free calls. The pause clears as
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
`test:workspace-admin-db` also runs the point-purchase webhook and credit-history
DB tests, including replayed events, refunds, tenant isolation, spent/reserved
balances, and the one-time gift.
Tests never use a production database, create a live Stripe charge or start an
E2B sandbox. Required PR CI supplies the production build, full functionality
and integration-branch performance acceptance.

## Hosted verification

Stripe Checkout owns the card form, Link eligibility, errors, and bank-required
authentication. Mikka does not receive authentication codes. A successful Link
login or Checkout return alone never grants credit: the verified completion
webhook must resolve a card fingerprint and run the existing claim transaction.
Regular cards and Link-saved cards use the same fingerprint claim, so saving or
reusing a card cannot grant a second allowance.
