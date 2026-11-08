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
  The issue's later credential-only requirement is included: devices no longer
  constrain full model IDs using CLI reports, `OrderView.deviceModels` is
  removed, and the native runner checks its exact lease/model instead of a
  shortcut catalogue. Structured provider model refusals continue the current
  preference-driven task on its next entry without global yellow status.
- #1556: a reproduced desktop transport defect. The community server's actual
  live ticket contains `/mikka/v1/live/<channel>/socket`, while `BundledLive`
  previously accepted only `/v1/live/<channel>/socket`. The fix accepts both
  supported paths and retains TLS, loopback, channel, userinfo/query/fragment,
  expiry and main-process ticket boundaries. Regression: old code rejects the
  community ticket; patched code passes both transport and rejection cases.
  The image CI now also runs a packaged Electron against that actual community
  image: explicit server selection, generated-account email login, authenticated
  RPC, built-in live socket, chat submission and a synthetic-model reply. Its
  receipt and screenshot are retained separately. The first complete image run
  passed the native checks, but its screenshot was obscured by onboarding. The
  current driver uses the ordinary Skip setup button before taking the image;
  that revision awaits CI. Neither case claims real Google OAuth or subscription
  acceptance.
- #1593: the report parser now retains nine closed validation booleans before
  refusing a native delivery. The historical artifact lacks the report text and
  the original combined assertion cannot identify which invariant failed.
  New receipts distinguish text/byte/digest integrity, issue/source binding,
  Owner choice and Evidence/Risks/Limits sections, without exporting report text.
  The original refusal remains strict; no failure is converted into a pass.
  A subsequent exact-run, Owner-hash-scoped read-only Neon query identified
  the historical failure: the final report omitted Limits. See the receipt below.
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
| #1593 | Historical failed invariant identified as missing Limits; rerun both fixed official subscription paths; collect dispatch latency, active keepalive, normal completion/cancellation and remaining external-wait/stage-handoff evidence. |
| #1212 | Production server-side MCP abort and public/private group Stop receipts, including cleanup. |
| #1560, #1565 | A real assigned thread completed by the daemon on the self-hosted installation; distinguish it from enrollment and transport. |
| #1561 | Local backend idle minute passed (below); rendered desktop/Web idle-minute and deployed self-hosted usage evidence remain. |
| #1562 | Real vault store → Agent autofill, plus plaintext-free logs, on the self-hosted target. |
| #1563 | Real self-hosted GitHub App clone → push → PR. |
| #1564 | Screenshots of a genuine cloud-binding flow. |
| #1566 | iPhone receipt; coordinated Expo enhanced-security production configuration and delivery verification. No production configuration was changed in this batch. |
| #1567 | Self-hosted cloud-model reply and exhausted-quota refusal. |
| #1568 | TestFlight device: connect, login, chat, return to cloud. |

No issue is closed solely because its code is on main, a guard job is green,
a synthetic model responds, or the client stopped waiting.

## Local production-build API receipt

At 2026-11-07 23:36 UTC the compiled Node-server build
`9787d259793ca9156de77dd48059a2d14fd1a7b4` ran at
`http://localhost:3139/mikka`, community edition, with a disposable PG17
`mikka_e2e` database. Eleven checks passed through real HTTP and browser RPC:
normal email sessions, authenticated catalogue, disabled-model dispatch
filtering, foreign source write denial and non-disclosure, entirely disabled
key choice denial, new catalogue entry off/fresh, seen-without-enabling,
foreign-origin 403, anonymous 401 and session sign-out. API catalogue rows were
explicitly synthetic; no model/provider request was made. The temporary key
was deleted and both sessions signed out. This accepts the application flow,
not a real subscription or hosted-billing provider.

CI's first Core unit failure was an outdated readiness-test query fixture,
which assumed every SELECT read only the saved bot binding. It now models the
new owner-scoped hosted-setting SELECT and the preferred-order fallback. Its
four tests and the complete 31-test self-hosted-BYOK suite passed locally.

## Historical Claude delivery diagnosis

At 2026-11-08 00:17 UTC, connected Neon SELECTs were scoped to the exact
historical issue, continuation and artifact Owner hash. The two run rows share
the expected Owner and issue. No credentials or report text were retrieved;
the server computed only booleans, counts and a command digest. No new model
request was sent and no database write was made.

- Origin: `4aba782a-de0e-4330-8881-040287c92dd3`.
- Continuation: `b38c04ba-f785-42c0-8b20-5e34e3ac6447`.
- Case: `8e02b085-565a-460f-be12-d424473f7441`.
- Delivery seq 23 has exactly one earlier native Bash/Shell input pair.
- Passed: text, 1606-byte length, SHA256, #1593, exact source SHA, Owner choice,
  Evidence, Risks, and the original 157-byte marker's digest and size.
- Failed: Limits. Case-insensitive `limits` and the `limitation` synonym are
  both absent. There is unverified-language elsewhere; the required section
  was nevertheless omitted.
- Native input command SHA256:
  `02849f351ae93d2f918839cd0a1d6668c631d467ee95ef7197898593f53b5d6a`.

The immediate cause is report completeness, not evidence of a VM resume
failure. The original case remains failed. The continuation prompt now repeats
the required final headings and asks the model to check each section before
delivery. Validation remains unchanged and the regression proves a missing
Limits section still throws while preserving only its closed diagnosis.
Full lifecycle acceptance remains independent and incomplete.

## Credential-only model follow-up

The old device gate reproduced RED for both Claude and Codex when an authorized
historical model was absent from the CLI shortcut report. After the change:

- 169 execution-rule unit cases and 24 context/dispatch cases pass.
- 39 protocol failure cases pass, including six structured model-refusal codes
  and rejection of bare 404/unstructured tool text as provider evidence.
- 45 real-adapter/native-CLI protocol fixture cases pass, including both
  harnesses without a model probe and exact mismatched-lease refusals. The
  initial local run inherited the executor's OpenAI key and failed its existing
  offline fake-auth guard; running the isolated fixture without that inherited
  key or Codex home passed. No product environment filtering was introduced.
- 47 real-PG17 model-order/provider-continuation cases pass. A structured
  model_not_found switches to the next authorized entry, keeps the original
  session/worktree and leaves the failed model's global availability unchanged.
  Foreign credentials and stale bindings remain excluded.
- 96 native provider-boundary/adapter/run cases pass, including Claude's
  structured model refusal and Codex badRequest/other model refusals. Ordinary
  tool errors and unrelated bad requests still do not trigger fallback.
- Application/API/frontend and daemon typechecks, source lint, polling and
  error-cause policies pass.

This adds a provider-failure contract variant; the ordinary version-bound Web
and E2B release gates still apply. Historical model-not-reported error rendering
remains solely for existing receipts; new dispatches do not emit that refusal.

## Local idle receipt

Production build `9787d259793ca9156de77dd48059a2d14fd1a7b4`, community edition,
isolated PG17, built-in scheduler enabled and an authenticated built-in live
socket held ready: from 2026-11-07 23:46:06.979 to 23:47:06.986 UTC (60,007 ms),
the instrumented application PG client made 0 calls, received 0 protocol bytes
and sent 15 protocol bytes; unknown readings: 0. No business reads or live
events occurred. Counters exclude connection setup, other processes and
TCP/TLS overhead. This is backend evidence, not a rendered-page idle test.
