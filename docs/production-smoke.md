# Production smoke

Company-hosted deployment and credential operations are maintained in the
[private operations repository](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/production-smoke.md).
Authorized operators start with its `AGENTS.md` and `docs/operations/README.md`.

Public self-hosting and product setup remain in [the documentation index](README.md).

Existing section links are retained as navigation only.

## The account

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/production-smoke.md).

## What it checks

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/production-smoke.md).

### Retained browser smoke

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/production-smoke.md).

### API-only smoke

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/production-smoke.md).

## When it runs

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/production-smoke.md).

## Required active coverage

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/production-smoke.md).

## Scheduled cloud run canary

`.github/workflows/cloud-run-canary.yml` runs at 00:41, 06:41, 12:41 and
18:41 UTC, or manually with **Run workflow** on `main`. It uses the existing
smoke account to dispatch one official Claude Code cloud task, read the test
repository's README, verify its reply after tool execution, wait for successful
completion, and confirm cleanup. It consumes ordinary billed cloud usage on
the smoke account; the smoke email tag is not a billing exemption.
Repeated runs reuse the owner's `测试1505 cloud-run-canary` bot in the selected
workspace instead of creating a bot each time.

The job summary reports `cloud-run canary: PASS/FAIL` and elapsed time when
available. Download the `cloud-run-canary-report` artifact for `report.json`.
A failed job requires investigation: authentication, configuration, dispatch,
execution or cleanup can fail. A pass proves this account's selected cloud
path worked at that time, not every provider, model or tenant.

The ops monitor skips dispatch-success assessment when its run denominator is
zero. A green canary alongside zero real runs distinguishes a working tested
path with no demand from an untested idle path. Canary runs themselves enter
the monitor's ordinary run counts; no synthetic demand-metric exclusion is
added by this workflow. This check does not certify startup-latency targets.
