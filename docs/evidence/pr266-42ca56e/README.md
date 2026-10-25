# PR266: published local acceptance evidence

Business candidate: **42ca56ebee733c9f5ed67bec0d48170e7506814e**, [PR266](https://github.com/alexj11324/Mikka/pull/266), based on frozen #258 `12368c4051c2b051828f681f46b7ff1148372f96`. This independent evidence branch adds text only. It neither changes that business head nor reruns the tests. These are recorded author-run results, independently reviewed from source/evidence; they are not a separate reviewer execution.

## Read the actual results

- [Six successful unknown-result cases](results/browser-six-results.json): email/update × intact/missing/null input. Corresponding chronological logs: [run5, email successes plus update connection-reset failure](logs/browser-run5.log), [run6, three update successes](logs/browser-run6.log).
- [Two successful expired-session cases](results/expired-session-results.json), [retest run2 log](logs/browser-expiry-run2.log), [PG retention readback](logs/session-retention-retest.log).
- [Actual local provider HTTP request log](logs/provider.ndjson), with original UTC timestamps; [Next runtime log](logs/runtime.log), including errors, not only passing lines.
- [Local combined test log](logs/pg-http-tests.log), [adapter test log](logs/adapter-tests.log), [CI terminal status snapshot](results/ci-status.json).
- [Publication provenance](provenance.json): every copied file's original/public SHA256, bytes, redaction flag and source filesystem mtime in UTC. Mtime is **not** an asserted execution start/end. Browser result JSON has no timestamps; correlate it with run ordering and provider/runtime logs.

### Count definitions — do not inflate the PG claim

[Dedicated CI 40216233639](https://github.com/alexj11324/Mikka/actions/runs/40216233639) passed **86 = 1 migration + 3 verifier unit + 13 ledger/session + 43 action/intent/adapter + 26 Factory** tests, zero skip. This is not 86 new-feature PG tests. The **43 include four mocked Composio adapter unit tests**; the remainder exercise isolated database/service/HTTP/intent paths, with a controlled provider, not a real external provider. The separately reported adapter 4/4 overlaps those four; do not add it again.

[Full CI 40216233736](https://github.com/alexj11324/Mikka/actions/runs/40216233736) succeeded: production build/typecheck, Factory PG164, group PG34 with two gated skips, navigation5, browser86 with one dev-only skip. Source-only jobs skip PG duplicates (Factory8, groups5); cloud OIDC is conditionally skipped. Same-repository PR-event duplicates are skipped while push jobs execute. See status snapshot and public CI logs, rather than treating all green/skipped cards as executed tests.

## Environment and execution boundary

Recorded on **2026-10-25 UTC**, cloud Linux, isolated loopback Next **16.1.6 dev/webpack**, real PostgreSQL17, real Better Auth synthetic identities and Origin checks. Node container: `node:24-bookworm-slim`, image `sha256:dc1f22974dab4be31a8b56d58cb1f8fc218e83de83ccd831d885b3d7ac1223fb`. PG container: `postgres:17`, image `sha256:82903352d6faf8f8a318bc4353d1cb1db67d4a5ff968d2799b2718e2cb00afa2`.

Application origin was `http://localhost:3128/mikka`, local provider `127.0.0.1:3129`; PG was local port55428 with a new retained schema. These addresses are historical local endpoints, **not public previews**. The Next container is stopped; PG/data and original artifacts remain privately retained except the disclosed original session row below. Existing proxy/CA configuration was used only for public asset retrieval; no credential values or runtime auth file are published.

Original UI approval list → actual Next server action → actual decidePendingAction, provider adapter, ledger and PG. Only SDK transport is replaced by the loopback HTTP double. The stub records one write then destroys the response socket. Repeat approval must return running and never resend; the event is attention/uncertain while the ledger remains executing. Actual client message API202 is followed by actual takeInbox, driven by the test control route, then the later ordinary message. A test-only explicit synthetic receipt import verifies the distinct terminal dedupe key. It is **not native provider reconciliation**.

The session-expiry cases expire the real synthetic session and click the original approval; the server denies execution and the HTTP stub sees no write. Fresh-process recovery is covered by the actual-service Node/PG suite, not by restarting a Next deployment. Automatic workflow/model continuation, real Gmail/Calendar effects, and production acceptance were **not run**. No paid models, real-provider calls, production SQL, merge or deployment occurred. Do not close #208 from this evidence.

## Inspect the harness, including its limitations

- [SDK transport double](harness/sdk-double.ts), [Next alias patch](harness/overlay-config.patch), [authenticated local control route](harness/control-route.ts).
- [Final all-six recording script](harness/record-all.cjs): used for run5; [Calendar-only retest script](harness/record.cjs): run6; [expiry script](harness/record-expiry.cjs): expiry runs. These are final saved scripts, **not historical snapshots of all earlier failed versions**.
- [Saved startup script](harness/start.mjs) includes the session-retention rule added after the initial expiry test. It is **not a byte-for-byte snapshot of the first launch**. Its dynamic secret/key material is generated at runtime; the fixed `synthetic-208-local-only` string is only the double's fixture sentinel, never an external credential.

Playwright forwards only the matching real server-action requests using route.fetch with `maxRetries:0,maxRedirects:0`, then returns the unmodified real body; it does not invent responses. This avoids CDP dev-navigation body eviction. Only read-only snapshot calls have bounded connection-reset retries. The original app/service/UI files remain unchanged by the overlay; this is nevertheless an **instrumented candidate**, not a pristine production deployment.

Archived launch shape (do not execute against any real environment): a host-network Node container mounted the candidate and evidence directories, plus the public CA certificate read-only; ran `node /workspace/208-approved-actions-evidence/start.mjs`. Browser recordings used `PLAYWRIGHT_BROWSERS_PATH=/workspace/245-video-evidence/browsers node /workspace/208-approved-actions-evidence/record-all.cjs` (then the Calendar-only/expiry variants). Paths identify the original isolated workspace; this publication does not set up a new environment.

## Failures and the retention incident remain visible

[Run1](logs/browser-run1.log): incomplete toolkit selection in the double. [Run2](logs/browser-run2.log): same-label send selector timed out. [Run3](logs/browser-run3.log)/[run4](logs/browser-run4.log): CDP response-body capture failed. Run5 passed email then encountered a local snapshot transport reset on update; run6 passed update. No business-head patch was made for these fixture corrections.

[First expiry log](logs/browser-expiry-run1.log) and [retention check](logs/session-retention-check.log) disclose that **Better Auth automatically deleted one expired synthetic email session before the local DELETE-retention rule existed**. That row was not restored. It is an original evidence-retention gap. Other user/proposal/ledger/video artifacts remain. The later rule prevents session deletion; both repeated expiry rows were read back as retained and expired. [Original first-expiry results](results/expired-session-results-before-retention-review.json) are preserved separately; passing behavior does not mean its original session was retained.

## Videos are inventoried, not uploaded

[Video manifest](results/video-manifest.json) lists eight successful original WebM captures, filenames, bytes and SHA256. The private edited compilation `266-42ca56e-key-excerpts.mp4` is64 seconds (last eight seconds of each case),532403 bytes, SHA256 `eb1bb3b0325d93995517a77df5155d9fc39fe0a8434101456738e8083e689a12`. It is labeled candidate/local-stub/edited and is not raw footage.

**No video binary is in this branch and no public video attachment is claimed.** Available GitHub tools lack binary attachment upload. Earlier official Library helper hosted-app authentication failed401 before preparing/uploading files; no bypass, direct-upload substitution or blind retry was attempted. A checksum inventory is not proof that a reviewer can watch a video. Original captures, screenshots and unredacted logs remain private pending an authorized supported upload route.

## Redaction and verification

[Redaction script](redact-evidence.py) documents processing. Original logs are not rewritten: public copies remove authentication/SQL-parameter lines, deterministically pseudonymize generated identifiers and redact email strings. Original and public hashes are recorded; the private mapping and unredacted content are not published. Result JSON and harness copies are unchanged. No real secret, token, session cookie or account PII is intentionally included.

A reader can verify published bytes/hashes using the following without running application/provider code:

```sh
python3 - <<'PY'
import hashlib,json,pathlib
p=pathlib.Path('docs/evidence/pr266-42ca56e')
for row in json.loads((p/'provenance.json').read_text())['files']:
    b=(p/row['path']).read_bytes()
    assert len(b)==row['publishedBytes']
    assert hashlib.sha256(b).hexdigest()==row['publishedSHA256']
print('Published evidence hashes verified')
PY
```
