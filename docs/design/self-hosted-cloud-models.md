# Connected cloud model credits

- **Status:** implementation for review
- **GitHub:** #1567, design PR #1559
- **Owner:** self-hosting implementation batch

## What the user does

A self-hosted person authorizes the `models` capability with their Mikka account,
or uses their administrator's server key. Their bot's default, short titles,
action titles, memory extraction and Decisions then use that authorization's
cloud workspace. Their selected Claude Code and Codex subscriptions remain
native provider connections on the task machine.

## Where it lives

Settings › Models and subscriptions lists `Mikka 默认（Mikka Cloud 额度）` only
when the effective binding includes `models`. It uses the same account section
as the existing subscription and API-key rows. The bot composer keeps its
existing picker and adds the `Mikka Cloud 额度` payment label. This follows the
connected-provider pattern already accepted for the self-hosting design in
PR #1559; no new navigation category or feature switch is introduced.

The default chooses a personal cloud binding first, otherwise a team server
key, then the administrator's explicitly configured provider. A personal binding
that is revoked or lacks the scope never spends the team key. Provider/network
or quota failures after selection do not silently switch the payer or provider.
Cloud availability is read from the local binding only, without token refresh or
remote calls. The actual request refreshes its one-hour token on demand.

## Layout and states

- Loading uses `SettingsLoading`; a failed status read uses `FieldError`.
- No effective `models` authorization means no cloud model row or picker option.
- A connected model row uses `SettingRow`, `MikkaMarkSmall` and the existing small
  outline button, `去 Mikka Cloud 充值` / `Top up in Mikka Cloud`.
- Quota refusal stays under the failed reply in `FailureReason`. The canonical
  bilingual `RunErrors.cloud_quota_exhausted.default` is used on web and phone.
- The recharge button resolves its URL only on click. The service names the
  actual public app path and the authorized cloud workspace through
  `/v1/models/billing`; the local server validates HTTPS, the issuer's origin,
  `section=billing`, and a workspace UUID. It does not infer an app path from
  the service URL. Existing billing actions recheck the signed-in cloud person's
  membership/admin role before a purchase.
- A lost cloud authorization is 403 on this locally authenticated billing route;
  only a lost local session is 401. It cannot log the phone out of its server.
- Settings use the existing `model_settings` live key, with no idle polling.
  Existing component primitives provide light/dark, narrow and keyboard states.

## Components and rules

R-40, R-42, R-74 and R-90: `SettingsSection`, `SettingRow`, `SettingsLoading`,
`FieldError`, `Button`, `MikkaMarkSmall`, `BotModelPicker` and `FailureReason` are
reused with their existing appearance. The only new wrapper is the stateful
`CloudModelSettings` composition in the existing `cloud-settings.tsx`; there is
no replacement design-system component.

## Billing and verification

The public default route accepts a server-owned billing adapter. Private cloud
passes an ordinary `HostedUsageStore` with `allowTrial:false`; both preliminary
admission and the transactional reservation require verification or purchased
credit and a positive balance. The public platform retains its existing trial.
Neither client JSON nor provider options can choose the adapter or its workspace.

The private implementation and schema stay in `mikka-cloud`. It reuses the
public router, its ZeroCat-first path, 20-second first-token Gateway fallback,
actual-cost settlement and unknown-cost reconciliation. The local installation
makes no hosted-usage debit for a cloud call. A private attribution row links the
server, authorization, pseudonymous actor and actual public ledger identity; it
stores no prompt, response or credential.

## Done when

- Scope/personal-priority, real SDK JSON/SSE, quota refusal, cancellation and
  existing hosted-route regressions pass.
- Real PostgreSQL proves paid-only admission, serialized team caps, attribution
  and actual-cost settlement on the exact pinned public/private commits.
- The owning agent reviews screenshots of the local production build in both
  themes and attaches them to the batch PR.
- The shared test account completes a small default-model call through the
  connected self-host and a direct Mikka call; record first-token timings,
  exact revisions/origins and ledger rows. Local fixture timings are not a
  substitute for this deployed comparison.
