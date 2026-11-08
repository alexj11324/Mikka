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
  corrected driver uses the ordinary Skip setup button; its six native checks
  and unobscured chat screenshot passed in run 42430159521 (receipt below).
  Neither case claims real Google OAuth or subscription acceptance.
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
| #1556 | Packaged desktop/community-image email, chat/reply and built-in live passed; real Google OAuth and external-provider acceptance remain. |
| #1593 | Historical failed invariant identified as missing Limits; rerun both fixed official subscription paths; collect dispatch latency, active keepalive, normal completion/cancellation and remaining external-wait/stage-handoff evidence. |
| #1212 | Production server-side MCP abort and public/private group Stop receipts, including cleanup. |
| #1560, #1565 | A real assigned thread completed by the daemon on the self-hosted installation; distinguish it from enrollment and transport. |
| #1561 | Local backend and real visible Web idle minutes plus all 10 request-budget cases passed (below); deployed usage and the remaining transport evidence still need their version-bound closeout. |
| #1562 | Real vault store → Agent autofill, plus plaintext-free logs, on the self-hosted target. |
| #1563 | Real self-hosted GitHub App clone → push → PR. |
| #1564 | Screenshots of a genuine cloud-binding flow. |
| #1566 | iPhone receipt; coordinated Expo enhanced-security production configuration and delivery verification. No production configuration was changed in this batch. |
| #1567 | Self-hosted cloud-model reply and exhausted-quota refusal. |
| #1568 | TestFlight device: connect, login, chat, return to cloud. |

No issue is closed solely because its code is on main, a guard job is green,
a synthetic model responds, or the client stopped waiting.

## Packaged desktop and actual community image

[Run 42430159521](https://github.com/alexj11324/Mikka/actions/runs/42430159521),
head `bce64f1b68ba1b5360bb0e48d8cc5207f1e41adf`, actual test checkout/image
`7e614596a926b1ee24333a41123be682c2d3ee3f`. Desktop receipt spans
2026-11-08 00:45:21.082–00:45:28.003 UTC. All six checks passed: real community
discovery/selection, normal email login and authenticated RPC, actual built-in
live ticket/socket, chat submission and fixture reply after live invalidation,
ordinary onboarding dismissal and visible reply, sign-out/default-server
return. Session, Electron, daemon and private handoff cleanup all passed.

Artifact [13597546455](https://github.com/alexj11324/Mikka/actions/runs/42430159521/artifacts/13597546455)
contains `desktop/report.json` and `desktop/self-hosted-chat.png`. Its ZIP SHA256
is `0522ec542362514dbc208262ee068aaf3171d07212297595afffb7710d202663`.
The owning agent downloaded and viewed the PNG: it shows the actual bot chat's
`selfhost_turn_32` and `SELF_HOSTED_REPLY_32`, unobscured by onboarding. Provider:
explicitly synthetic OpenAI-compatible. Google OAuth and subscription
acceptance are false in this receipt. It proves the native product transport
and image flow, not those separate external-service requirements.

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

The first full CI run of this follow-up exposed eight old model-report
assumptions in the Coordinator prompt, difficulty routing and startup recovery
database fixtures. The fixtures now distinguish missing credential injection
from a non-exhaustive CLI model list. All 35 cases in those three real-PG suites
pass, retaining out-of-list refusal, quota/pause/offline exclusion, fixed model
identity, Factory task ancestry and original Owner-event checks. No production
behavior was changed to preserve the superseded report gate.

The combined-main run also exposed two group-intent fixtures that removed a
model shortcut while leaving its Agent installed. They now prove both sides:
the shortcut omission preserves the deferred quota intent, while an actually
absent Agent cannot skip a pending preferred allowance for a later source.
All 140 cases in the complete Factory Profile-dispatch PG17 suite pass.

## Local idle receipt

Production build `9787d259793ca9156de77dd48059a2d14fd1a7b4`, community edition,
isolated PG17, built-in scheduler enabled and an authenticated built-in live
socket held ready: from 2026-11-07 23:46:06.979 to 23:47:06.986 UTC (60,007 ms),
the instrumented application PG client made 0 calls, received 0 protocol bytes
and sent 15 protocol bytes; unknown readings: 0. No business reads or live
events occurred. Counters exclude connection setup, other processes and
TCP/TLS overhead. This is backend evidence, not a rendered-page idle test.

## Later integration and visible-page evidence (2026-11-08)

Head `a4e2dff44fa0be8be41b7da5c891f21676fbfb57` passed all 13 applicable
PR workflows: 34 successful checks and seven existing conditional skips,
with no pending or failed checks. Image run 42434350612 used checkout
`9aa1707aff4a63da319c48c3e1d8055a8117dbc3`, whose tree equals the a4 tree.
Artifact 13599885150 contains six passing native checks and complete cleanup;
its actual turn-32 chat screenshot was downloaded and viewed. The provider
remains synthetic. ZIP SHA256:
`7e751082bd8e33dbb171cae9fe903c0480681372c74cc9bc8d7a00a2993e16fc`.

An isolated local combination of a4, main ba19681c and audit batch 7c7d8d8a
has tree `9ffbfd2b2fed5791e1c14a93acddacf1e5f917a4` (local virtual commit
`b966b48f79de805734548e0e54b2a3fcec3830ed`, never pushed). Root/API and
the frontend's pinned TypeScript 5.9 checks passed, as did 20 Factory unit
cases, 13 real-PG continuity/epoch cases and all 10 idle-budget cases; no skips.
This is bounded integration evidence, not a deployed-source claim.

The same combination's real community production build served a normal
authenticated, visible 1440x1000 Chromium home page. Built-in live and the
scheduler were enabled, with no Cloudflare or Vercel configuration. Startup
briefings and ops-monitor actually returned HTTP200. From 02:16:10.411 to
02:17:10.451 UTC (60,004 ms), after 357 positive-control PG calls and a counter
reset: zero SQL calls, zero PG receive bytes, 50 PG send bytes, zero unknown
readings, zero business HTTP calls and one existing version request. There
were two WebSocket receive frames and no browser errors. The screenshot was
viewed; sign-out plus session-null, browser close, app stop and PG removal
were verified. There were no external model calls. Report SHA256:
`720a547e3ed54ea3ed107e37b64bdf64f29c436c7173ebf572a654fefbff39c4`.
This remains one local page/minute, not an hourly production measurement.

Issue #1567 also links the verified historical API call 42385723293 and the
read-only receipt in **mikka-cloud** run 42386145460: 50 tokens, settled
21 microUSD, matching authorization and payer. It used a personal billing
workspace and does not prove the current shared-Team Coordinator or quota UI
flow. Reading those receipts made no new paid request.

Main 3c32675c subsequently changed shared CI selection and its image workflow;
its normal merge is being validated separately. The older green a4 results
are not relabeled as that new head's CI. Production credentials remain inside
existing Actions/OIDC delivery; identity/configuration discovery is metadata-only.

## Exact-head and real-cloud evidence (2026-11-08 05:00 UTC)

Implementation head `839d43546bf7e113d58eecdfa604962ca2cea8f6` passed CI
42441716968: 36 successful checks and seven expected conditional skips.
The actual checkout `7c5808acc7ee1bcbe7aefd5c7860de9016ba426a` has tree
`0a16ba3a827cf6b67c68b53b33c9d9d24a92b3af`, exactly equal to that head.
Image artifact 13601863068 was independently downloaded, its reports read
and native chat screenshot viewed. Six packaged Electron checks, the 31-turn
synthetic-provider service flow, two-replica live and MinIO passed. Daemon
enrollment, heartbeat and gateway checks passed; taskCompletion and actual
subscription execution remain false. ZIP SHA256:
`ffb898fbce8fc8283aff3d4aa2ccc81f45d3110e3ee31f8b56acf0a5805c4058`.
Apple Silicon artifact 13602143008 proves an ad-hoc acceptance package,
not a signed/notarized stable release.

The following later production probes use public source
`f1324dafa296f76289124bb93538f1938cb1597f`, its published image digest
`sha256:0972e911ae6020f95aaf9fb62ae499f0f6ec67fc63e737cec25334ad48784c51`,
and private cloud source `d6f0ece2237904e7b5f23cf92a9d6492e123e6c2`.
They are not tests of unpublished #1688 code. Operations run in the existing
non-cancelling shared-account queue; secrets stay inside Actions/OIDC.

- Run 42443657957 proves native consent POST omits the clicked submitter's
  approve value and returns 403. The real request retains CSRF, request ID
  and selected workspace. A candidate private fix preserves submit values
  with aria-disabled plus a repeat-submit guard; old/new actual-component
  native submissions reproduced RED/GREEN for both Allow and Cancel.
- Run 42447328652 proves the normal Coordinator sends 66 valid function
  declarations, rejected by the private API's 64-declaration limit before
  provider work. A private candidate accepts 66 and 128, rejects 129, and
  retains the distinct per-message 64 tool-call limit.
- Complete private candidate `f6ab81a63eebcebdce5e387fdbdc08000f79c435`
  passed candidate-only CI42447693173: 7+59 core and 6 real-PG/HTTP tests,
  no failures or skips within those suites. UI/models typechecks and a real
  UI production build passed. It is a reviewable branch only: no second PR,
  no private main write and no deployment. Neither production defect is
  relabeled as fixed in production.
- Run 42448009597, 04:45:55–04:47:24 UTC, received real CLOUD_CLOSEOUT_OK
  through self-hosted live v2. This independent billing fixture explicitly
  uses an owner-configured zero-tool profile with audit retained, not the
  failing general 66-tool Coordinator. Normal backend PKCE HTTP approval is
  separately marked; native browser consent still failed. Fixture-only
  fetch instrumentation makes this unsuitable for clean latency comparison.
  A read-only join bounded by the owned server ID, exact name, origin and
  time window proves settled 27 microUSD for
  deepseek/deepseek-v4.1-flash and 27 microUSD for
  openai/gpt-6-luna-decisions. Both payers equal the selected personal grant
  workspace and public ledger workspace. Decision's stored zero token
  counts do not establish actual zero token use. The old driver's settlement
  assertion incorrectly excluded a legitimate Decision row; its failure is
  retained, while the specific reply and settlement facts stand.
- Run 42448559953 is not a valid exhausted-credit sample: its team had
  zero own balance but an existing active, opted-in credit sharer. Scoped
  read-only relations prove the normal credit-sharing fallback paid the
  default/Decision calls. No shared configuration was changed. The driver
  timed out expecting a refusal and remains failed; no quota/UI pass is
  inferred. Subsequent refusal probes use only a disposable server key's
  own small limit and must name that boundary explicitly.
- Run42449083440 completes registration, independent protocol approval,
  personal revocation, separate-team key creation/binding/revocation and
  server disconnect, with 35 actual full-page 1440-wide masked screenshots.
  Native consent still fails and the overall run remains failed. Its owned
  USD0.01 key limit rejects a larger model reservation before provider I/O;
  a scoped read-only ledger query proves zero model calls and zero charges.
  The API loses cloudCode and the UI shows generic Reply failed instead of
  the quota copy/recharge action. Run42449447361 exports only the exact safe
  stored error grammar, confirming the root cause:
  `Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: cloud_quota_exhausted`.
  The strict bare-code parser did not recognize that model-step envelope.
  This batch now unwraps only that specific SDK streaming-step grammar for
  presentation and retains the closed cloud-code allowlist. Tool bodies,
  other steps, quoted codes and arbitrary provider text stay generic; model
  fallback, credential health and authorization do not change. The old code
  reproduced RED, and the exact error plus positive/negative unit cases are
  GREEN. Publication and rendered candidate evidence remain separate gates.

The first isolated production-build replay at 192d2669 passed the real
HTTP/Workflow and API cloudCode checks, then correctly failed its visible-copy
assertion. The newest failure banner still bypassed the shared cloud recovery,
although historical failures already used it. Current and historical failures
now share the existing CloudFailureAction; the current notice retains the
existing Alert and guarded RetryReplyButton for retryable errors. The new
current/historical quota rendering cases reproduced RED/GREEN; all 34 DOM
cases pass. No new copy, requests, polling or model fallback is introduced.

All owned servers in those completed binding runs were revoked; Coordinator,
local/cloud/OAuth sessions, browsers, isolated database volumes and tunnels
were cleaned up. There is no new polling, identity or production Expo change.
The five-minute external PR-status fallback is retained.

The independently read lifecycle artifact 13604971282 from run42448167220
has ZIP SHA256
`f1a398d791fc1375adc8be828c865bcaa494e02ff5f17c71b867b10d9508601b`.
On f132, Claude Haiku 5.5 proves original VM/SID, normal Owner answer,
marker/draft continuity, native report and all nine delivery checks including
Limits. It deliberately stops before unpinned next-stage model selection;
full Factory completion is unproven. Codex GPT-6 Luna fails before the native
question with lifecycle_pre_question_marker_missing. Both owned VMs were
confirmed missing and sessions/workspace restored. The overall run remains
failed and #1593 remains incomplete.
