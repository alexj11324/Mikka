# Independent review: DesktopIntegration task-list live migration

Reviewer: `/root/egress_1211`  
Date: 2026-11-05 UTC  
Base: `5d2011f0f27a4ae300909dd1632ffede8a763471`  
Candidate tree: `6050481953e91c6b32c2f03a48d62e9cdf3a3760`

## Conclusion

No blocking source defect was found in this three-file migration. It removes DesktopIntegration's independent fifteen-second task-list read and consumes the already deployed owner-keyed live-list hook. The owner lifetime guards cover the asynchronous native side effects added to the reviewed boundary.

This is an independent static review plus inspection of the implementation agent's existing raw evidence. The reviewer did not edit product/test source, run tests, use a production session, dispatch model work or trigger a deployment. Ordinary exact-head CI and the issue's production acceptance gates remain required. No production-hour or egress reduction conclusion is made here.

## Exact scope and integrity

All three complete candidate files were copied into the independent review snapshot and independently hashed:

| File | Git blob | Bytes |
| --- | --- | ---: |
| `components/desktop/desktop-integration.tsx` | `05cceda9c82df78dbd1178d396b88eeb0d0ffcf3` | 4,344 |
| `package.json` | `8e9cd60ff01b18272a24b586276dba054a4bd8ab` | 63,243 |
| `scripts/desktop-task-list.live.test.tsx` | `4f447c08c9f42fb945c42ded9e2b696aa5b3795d` | 19,991 |

Their SHA-256 values and byte counts match `evidence/candidate-metadata.json`. The final source/test hashes also match the GREEN log's accompanying hash receipt. Package JSON was compared against the exact base read directly from GitHub: its only change appends `scripts/desktop-task-list.live.test.tsx` to `test:live-lists`; every other parsed field and script is identical.

The final metadata records eleven relevant dependencies unchanged between the original `efef5b5a…` base, final base and candidate. This reviewer directly fetched and read ten of them: the live list hook, read metadata helper, live hook/provider, channel, channel registry, notification rules, preference predicate, task-run action, notification Decision action and platform hook. Their returned Git blobs match the recorded values. The remaining workspace-app mount dependency is recorded by the author; it was not re-read as part of this final review.

The original 21-file evidence manifest and the final 32-file packet manifest were independently checked by byte count and SHA-256. The supplementary warning trace is recorded separately and does not replace those originals. The final packet README was also read and preserves the same acceptance limits.

## Product behavior reviewed

### Desktop and Owner lifecycle

The outer component uses the existing platform detector and mounts the reader only for a desktop runtime. It returns no reader, subscription, preference request or native effect for web. The child is keyed by `userId`, so changing Owner creates a new notification baseline rather than carrying the previous Owner's status map forward.

The live task data uses `['task-runs', ownerId]`. Its fetcher checks the authenticated response Owner before rows enter that key; a mismatched response is unavailable to the component. The canonical home transport is derived from that same authorized response, not the currently selected team. Missing/inaccessible home remains a null transport with the existing slow fallback; this migration does not create or guess a workspace.

The underlying server contract is unchanged: `listTaskRuns()` already returns `(await pollTaskRuns()).items`. Switching the client to `pollTaskRuns` through the shared hook therefore preserves the same owner-wide task selection and additionally retains its scope/deadline envelope.

### Native notifications and late callbacks

The existing `desktopRunUpdate` still seeds the badge and status map on the first snapshot without replaying old notifications. Later state transitions remain candidates for the existing Decision action; only returned approved candidate IDs can reach the native notification bridge. Repeated identical list state does not submit another Decision.

A component lifetime generation is captured before a Decision call. Cleanup advances it, so a result settling after Owner replacement, a switch to web, or unmount cannot call the old bridge's notification show method.

The native click subscription and the asynchronous pending-click read share a local live flag. Cleanup clears that flag before unsubscribe, so an already queued old listener or delayed pending click cannot navigate after the lifecycle ends. The existing relative application-link validation and workspace navigation remain unchanged.

The existing automatic local-device setup retains its own cleanup guard, now scoped naturally to the keyed desktop child. No new setup, Decision, authorization or notification service is introduced.

### Preferences: preserved contract, explicit limit

The existing shared `preferences` SWR key and existing `pushAllowed` predicate remain intact. A finished notification still requires loaded preferences, `proactive` and `pushFinished`. Awaiting/failed candidates continue to use their existing Decision policy; this migration does not silently apply a different finished-preference rule to them.

The shared preference read has no authenticated Owner envelope. This is an existing Settings/Decision contract, intentionally outside this small migration. The tests prove the current preference switches affect this consumer; they do not prove cross-Owner preference response isolation or repair that broader contract. Nothing in this review treats keyed task data as evidence that the shared preference key is Owner-bound.

### Shared reads, visibility and deadlines

The component adds no timer or second socket implementation. It uses the existing list hook's zero SWR refresh interval, owner-home invalidation key and two-second event coalescing. The common channel already provides capability-aware health, shared-key deduplication, in-flight dirty/trailing reads, monotonic timing, visibility cleanup and reconnect catch-up. Unsupported/disconnected transport retains the existing sixty-second fallback.

The new fixture exercises the actual React component, SWR, list hook and channels together. A peer list consumer shares one event-triggered revalidation. Selected-team events cannot substitute for the owner-home event. Hidden state suppresses reads; visibility or reconnect performs a current read. Server-derived expiry still performs a read and can remove an expired badge without an event.

The final quiet-window evidence starts after two initial reads: the ordinary initial fetch and connection-opening catch-up. It demonstrates the absence of the old periodic fifteen-second read; it does not claim only one initial request or measure production traffic savings.

## Evidence inspected

| Gate or regression | Raw result |
| --- | --- |
| Same final fixture on old product | RED exit 1: after 16,101.739 ms, task reads increased from 1 to 2 |
| Same final fixture on candidate | The quiet-window case passed: after 16,102.282 ms, task reads remained 2 to 2 |
| Complete final `test:live-lists` | 31 passed, 0 failed, 0 skipped: 18 new desktop cases plus 13 existing list cases |
| Existing healthy list interval | Actual approximately 62-second test passed as part of the combined suite |
| Final typecheck | Exit 0 |
| Final targeted lint | Exit 0, no warnings or errors |
| Navigation policy | Exit 0 |
| Workflow/route type generation | Successful log: 149 steps, 6 workflows, route types generated |

The shared final test file SHA-256 is `302d16cff49f75bbd885fccf011284d607233bcd93f1b277e437cd76bf58d03b` in both RED and GREEN hash receipts. Only the product under test was restored for that RED comparison. The new cases include Owner replacement, late old-Owner HTTP results, a wrong authenticated Owner, a late cookie-Owner response under the old key, late Decision results after web/unmount, preference gates, denial/error without retry, hidden/visible, reconnect, expiry and all three pending-click cleanup cases.

The first typecheck failure is retained: two TS2339 errors arose from assertion-driven `never` narrowing in the preference fixture. The final assertions still require an empty decision list via its zero length, preserving the runtime check without that narrowing. The final typecheck log and explicit exit receipt are successful; the earlier failure is not relabelled as a pass.

## Timing warning retained and bounded

Both the new desktop fixture and the existing list fixture emitted `TimeoutNaNWarning` around synthetic visibility changes. The author preserved the warning and ran one narrow diagnostic on the unchanged hidden fixture. Its trace and recorded SWR 2.5.1 vendor excerpt show the focus callback registered through a bound `setTimeout`; HappyDOM passes the visibility event into the Node timer's delay position. The diagnostic passed, and no common-channel or product code was altered to silence it.

This is a test-environment warning with an inspected concrete trace, not evidence of a new fifteen-second data poll. The trace and vendor excerpt remain in the evidence package. The review does not describe the complete test output as warning-free.

## Acceptance limits

- Service reads, native-shell bridge, ticket/WS transport and Decision responses are boundary mocks. React, SWR, component notification rules and the shared channel implementation are real. This is not an Electron/OS notification acceptance.
- Visibility changes in the fixture are synthetic DOM events; this is not the separate physical-browser hidden/foreground acceptance used for other PRs.
- The server readers, event writers, permissions, shared preference service and Decision service are unchanged. This narrow review does not re-certify all those systems.
- No PG fixture, production junk data, live model request or production setting was created by this review.
- Final head-linked CI, normal release/version evidence, production desktop behavior and the tracking issue's required fixed-hour comparisons remain separate gates.

