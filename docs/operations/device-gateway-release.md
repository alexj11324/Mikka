# Device gateway release and acceptance

Company-hosted deployment and credential operations are maintained in the
[private operations repository](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/device-gateway-release.md).
Authorized operators start with its `AGENTS.md` and `docs/operations/README.md`.

Public self-hosting and product setup remain in [the documentation index](../README.md).

Existing section links are retained as navigation only.

## Existing resources and delivery

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/device-gateway-release.md).

The Worker reports each device's session to the application
([decision 2026-11-17-2215](../design/decisions/2026-11-17-2215-device-session-no-heartbeat.md)).
Besides the existing `DEVICE_SESSION` Durable Object binding and the
`GATEWAY_PUSH_SECRET` secret, it needs one plain text variable:

| Binding | Type | Value |
| --- | --- | --- |
| `DEVICE_SESSION_REPORT_URL` | Plain text variable | The application's `https://` endpoint up to `/v1/internal/device-sessions`, for example `https://app.example.com/mikka/v1/internal/device-sessions`. The gateway appends the device ID and sends `GATEWAY_PUSH_SECRET` as the bearer. |

Releases deploy with `--keep-vars`, so the variable is set once on the Worker,
in the dashboard or with `wrangler deploy --var`, and not in `wrangler.jsonc`.
`scripts/device-gateway/deploy.mjs` refuses to release (`gateway_session_report_url_required`)
while the Worker lacks it. Without it no device comes online.

> **Note:** The private runbook in `alexj11324/mikka-cloud` must add
> `DEVICE_SESSION_REPORT_URL` to the production Worker before the first
> release of this change, and its acceptance must check that a daemon's
> connect and disconnect reach the application.

## Release checks

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/device-gateway-release.md).

## Runtime acceptance

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/device-gateway-release.md).
