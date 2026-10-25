# Credential release acceptance — #180 / PR #223

Status: **incomplete**. The parent coordinates one integrated commit and all releases.
Do not independently merge/deploy this candidate or replace another task's deployment.
Completion requires verified preproduction, a coordinated production release, then a
real authorized user workflow on production and sanitized video attached to this PR.

## Release ledger

Record exact integrated SHA, immutable environment URL, UTC, migration revision,
runner version and reviewer. Deployment-to-SHA mapping needs independent release
metadata; an operator-supplied SHA is not proof. Keep private request/run/session IDs
in private evidence; use consistent opaque labels in public summaries/videos.

- [x] Candidate `9035b3e`: remote CI code checks, build, navigation and browser regression passed.
- [x] Scoped independent backend integration/cleanup review completed for that candidate.
- [x] Maintainer-approved exact Codex CLA exemption merged in #226 (`c0f702f`).
- [ ] New synchronize run confirms CLA success; no impersonation or attribution rewrite.
- [ ] Parent's single integration SHA includes backend, Claude form and dependencies.
- [ ] Independent review and CI pass on that integrated SHA.
- [ ] Dedicated runner isolation, ingress/body/trace exclusions and crash reclamation verified.
- [ ] Real preproduction matrix below passes on that SHA; evidence reviewed before release.
- [ ] Parent coordinates production release after validation.
- [ ] Real production workflow and permitted negative cases pass; sanitized video attached to PR.

## Authorization gate before running

Parent must supply the fixed URL/SHA and approved existing test owner(s), task/run,
service/origin and account. Specify which actual credential is used, destination and
purpose without putting its value in chat. Confirm existing vault path/identity and
permitted access; do not alter IAM, create provider grants or incur charges implicitly.

**Creation/update permission does not imply deletion permission.** This backend deletes
short-lived vault records and browser state on use/finish/cancel/expiry. Even status GET
calls can perform lifecycle cleanup. Obtain approval covering the exact test records,
profiles, sessions and fixture resources, including automatic cleanup, before starting
any lifecycle test. Without that approval, do not create live requests or run these
remote probes. Existing local acceptance scripts also drop fixture databases and delete
browser profiles; do not rerun them under a no-deletion rule.

## Executable status probes

`scripts/check-credential-deployment.mjs` performs three fixed-origin GET checks under the repository-configured `/mikka` base path:
unauthenticated refusal, owner access to an already approved request, and another
approved owner's refusal. It follows no redirects, sends no secrets in URLs, discards
all bodies and outputs only numeric status/header results and declared SHA. It does
not prove login, telemetry redaction, model behavior or deployment identity.

A trusted operator supplies these through the normal protected process environment;
do not paste cookies in shell commands, screenshots, repository files or model tools:

- `MIKKA_ACCEPTANCE_ORIGIN`: approved exact HTTPS origin, no path/query/userinfo.
- `MIKKA_ACCEPTANCE_SHA`: independently verified full integrated commit SHA.
- `MIKKA_ACCEPTANCE_REQUEST_ID`: existing approved test request.
- `MIKKA_ACCEPTANCE_OWNER_COOKIE`, `MIKKA_ACCEPTANCE_OTHER_OWNER_COOKIE`: explicitly
  authorized existing Mikka sessions, held only by the trusted operator process.
- `MIKKA_ACCEPTANCE_LIFECYCLE_APPROVED=1`: operator affirmation of the specific approval
  above, not a mechanism that grants permission.

Run `node scripts/check-credential-deployment.mjs` only after those prerequisites.
Missing identities, rejected requests or disabled backend cannot produce a passing
probe set. `GET_PROBES_PASS` is deliberately not overall acceptance.

## Real workflow matrix

Use Claude's actual Mikka form and current harness; no substitute mock card or direct
helper-only sequence. Preserve the original failing case and retest after any fix.

| Case | Required observable result |
| --- | --- |
| Agent requests credential | Actual task/tool creates owner/run/session/origin-bound request; only opaque references reach model/chat. |
| Owner submits via secure form | Independent HTTPS intake writes approved vault record; no secret in chat, SSE, logs, trace or screenshot. |
| Sensitive phase | All exposed browser observation/action paths refuse during filling; no shared CUA/browser attach. |
| Login and continued work | Approved target verifies its own login; same task navigates/clicks another protected page and reads non-sensitive content. |
| Wrong owner/run/session/origin | Refusal and no credential use; no state leakage or redirect escape. |
| Duplicate/expired submission | Refusal without second use; clear form error state. |
| Cancel/TTL/revocation | New use refuses; only specifically approved resources cleaned, with observable final state. |
| Provider/runner failure | No false success; quarantine blocks reads; authorized cleanup retry/restart recovery verified. |
| Actual model turn | Harness uses opaque tool references and receives useful post-login result, without secret-bearing parameters/output. |

Inspect private server-side evidence in the trusted environment. Publish only technical
counts/results, not raw model logs, headers, cookies, tokens, vault bodies or database dumps.
Do not turn off required isolation to get a successful recording.

## Video capture and publication

1. Use a dedicated test desktop with only the actual Mikka UI visible. Hide account
   addresses, URL query parameters, developer tools, terminal, password managers and
   unrelated notifications. Use non-sensitive fixture names in visible task content.
2. Capture the real task request and form's empty state. **Stop recording before secret
   entry, autofill, clipboard access or any sensitive target phase.** Also disable all
   agent screenshot/recording paths during that phase as required by the runner.
3. Resume only after verified cleanup/unlock and confirmed non-sensitive UI. Capture
   login success, a real protected-page action, result return and approved failure cases.
   Label the omitted sensitive interval; do not claim it is a continuous recording.
4. Keep originals private. Review every retained frame and audio track for secrets and
   personal data; remove audio unless needed. If sensitive material was captured, block
   publication and follow the owner's incident/cleanup instructions; do not independently
   delete or rotate accounts/tokens.
5. Produce a sanitized clip with UTC, exact SHA/environment label, case labels and
   expected/actual results. Preserve failures in the report. A screenshot alone does
   not satisfy the requested video.
6. After review, attach the sanitized video to PR #223 using GitHub's supported upload
   flow and verify the attachment resolves. Do not upload raw logs or token-bearing
   screens; do not fabricate an attachment URL. Report attachment ID/link and version.

No video or real preproduction/production pass has yet been produced by this task.
