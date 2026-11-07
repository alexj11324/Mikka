# Self-hosted completion batch

Source base: `0479675e188efeac341b207d8616c4d7b9d4ee23`.
Branch: `batch/self-hosted-completion-20261107`. All changes in this round use
one PR. This file is a coverage ledger, not a claim of production acceptance.

## Implemented in this batch

- #1539: persistent source settings, subscription release reconciliation using
  the existing #1515 family policy, conservative legacy migration, concurrent
  API catalogue refresh handling, authenticated settings actions and explicit
  desktop/browser RPC schemas. Disabled models are excluded from catalogues,
  exact fixed-profile candidates, saved bot bindings and preferred orders.
  Next bot turns follow the preferred available source; existing frozen turns
  are unchanged. The hosted source currently exposes the installation's single
  configured default model; there is no invented hosted model catalogue.
- #1556: a reproduced desktop transport defect. The community server's actual
  live ticket contains `/mikka/v1/live/<channel>/socket`, while `BundledLive`
  previously accepted only `/v1/live/<channel>/socket`. The fix accepts both
  supported paths and retains TLS, loopback, channel, userinfo/query/fragment,
  expiry and main-process ticket boundaries. Regression: old code rejects the
  community ticket; patched code passes both transport and rejection cases.
  This is not packaged-application/OAuth acceptance.
- #1593: the report parser now retains nine closed validation booleans before
  refusing a native delivery. The historical artifact lacks the report text and
  the original combined assertion cannot identify which invariant failed.
  New receipts distinguish text/byte/digest integrity, issue/source binding,
  Owner choice and Evidence/Risks/Limits sections, without exporting report text.
  The original refusal remains strict; no failure is converted into a pass.
- #1212: retain the existing five-minute external PR-state reconciliation when
  a webhook is unavailable. No page or database polling is added.
- Superseded drafts #1303, #1531, #1538 and #1579 were closed. Their issue
  acceptance status was not changed.

## Evidence reviewed

- [Lifecycle run 42416273179](https://github.com/alexj11324/Mikka/actions/runs/42416273179):
  source `a23b2e0b48dc5cb2dac8bb9ecde734a03537339e`; provider integration
  and automatic retirement passed with cleanup. Claude native continuation
  failed `lifecycle_review_delivery_invalid`; Codex question/resume passed.
  Artifact `13593365402` was read through the connected GitHub tool. Its
  aggregate explicitly keeps issue acceptance incomplete. No historical
  report was edited. No new model calls were made during this inspection.
- [Lifecycle run 42421853213](https://github.com/alexj11324/Mikka/actions/runs/42421853213):
  authorization succeeded, acceptance job skipped. Its green workflow status
  supplies no new runtime evidence.
- [Cloud compatibility run 42421363286](https://github.com/alexj11324/Mikka/actions/runs/42421363286):
  `core_target_changed`, detail `main`, before account credentials were read.
  This is a version guard refusal, not a daemon-task/product failure.
- The cloud compatibility driver deliberately sends no model request. Neither
  it nor daemon enrollment/gateway checks proves a daemon completed a task.

## Remaining acceptance; issues stay open

| Issue | Still required |
| --- | --- |
| #1539 | Connect settings UI to the actions below; real production source toggle/refresh and migration checks. |
| #1556 | Packaged desktop against the actual community image: email and real Google login, chat/reply and built-in live delivery. Unit transport tests do not replace this. |
| #1593 | Identify the actual failed delivery invariant in the Claude continuation; rerun both fixed official subscription paths; collect dispatch latency, active keepalive, normal completion/cancellation and remaining external-wait/stage-handoff evidence. |
| #1212 | Production server-side MCP abort and public/private group Stop receipts, including cleanup. |
| #1560, #1565 | A real assigned thread completed by the daemon on the self-hosted installation; distinguish it from enrollment and transport. |
| #1561 | Self-hosted idle-minute request/usage measurement. |
| #1562 | Real vault store → Agent autofill, plus plaintext-free logs, on the self-hosted target. |
| #1563 | Real self-hosted GitHub App clone → push → PR. |
| #1564 | Screenshots of a genuine cloud-binding flow. |
| #1566 | iPhone receipt; coordinated Expo enhanced-security production configuration and delivery verification. No production configuration was changed in this batch. |
| #1567 | Self-hosted cloud-model reply and exhausted-quota refusal. |
| #1568 | TestFlight device: connect, login, chat, return to cloud. |

No issue is closed solely because its code is on main, a guard job is green,
a synthetic model responds, or the client stopped waiting.
