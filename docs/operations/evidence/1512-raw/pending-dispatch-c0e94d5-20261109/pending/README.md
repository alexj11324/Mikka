# Issue 1512: Native pending-dispatch regression

Base head: 1ffa581f16319381054e0636ae41e6292719a1fe. The original Native run checked out c3b547d0e4d20692643fc95a5194b7ee8cf7f5c0, tree bc4d584fa651385886e79dc6359b1b43324425d1.

## Result

The final six-file candidate passed all 75 tests in scripts/use-live-lists.live.test.tsx with Node 24.22.2, with no filter, no failures, no cancellations and no skipped tests. The exact final source hashes are in pending-dispatch-source-manifest.safe.json and the raw output is pending-full-final.original.log. The candidate is stored as Git blobs only; no branch or CI run was created.

A real React/SWR/PersistentReadCache/HydrateReadCache fixture demonstrated this order: list fetcher enters, live ready arrives, the real Native MessageChannel queue dispatches HTTP, and the real live timer flushes before the response commits. Baseline performed two bot-chat-summary reads and two roster reads in three physical requests. The candidate performs one of each in one request. Both the old and candidate before-ready cases still perform the required second reads.

The pending dispatch hint only permits waiting. Completion still needs the existing response-object proof, exact committed cache identity, current scope and every revision requirement. Repeated capture/notification revokes the hint and wakes an active wait. The final case executes the real batch 404 capability fallback, holds both single fallback responses, and proves catch-up completes before those old responses are released. It is last because capability fallback is intentionally sticky for a document.

## Preserved negative evidence

The initial 6-case baseline is 5 pass / 1 fail. A corrected diagnostic-label version reran those same cases against unchanged runtime and has the same outcome. The original log is not rewritten; its delayed response label used a mutable total and the later fixture uses a per-request constant.

Moving the began check after an unconditional await is rejected: it fixes the pending example but breaks the existing hung-before-ready regression (6 pass / 1 fail). A separate owner-home hint test preparation is retained as an unapplied experiment, 4 pass / 6 fail. The candidate does not include that design. A Provider workspace hint by itself remained an ineffective negative control.

## Scope and reproduction

This is cloud Linux source-level execution with actual React, SWR, live scheduling, persistent cache/hydration logic, Native RPC queue, codec and MessageChannel. Only authenticated HTTP responses, socket events and storage are fixture boundaries. It is not packaged macOS, a production browser or a database benchmark.

The toolchain, frozen minimal dependency lock and complete source manifest preserve the execution environment. Node 24.22.2 was downloaded from its exact official release and checked against SHASUMS256.txt; pnpm 10.34.3 was checked against the registry integrity. Necessary dependency package/snapshot blocks are copied from the fixed repository lock, with original integrity data. The existing server-only test import hook and tsx entry were used.

The standalone apps/desktop/scripts/read-batch.test.mjs was not executed: its original frontend loader imports additional Tailwind/TypeScript/native SWC modules outside the minimal environment. No substitute loader was used. Full repository typecheck and lint remain unexecuted in this receipt. Actual Native queue and capability-fallback behavior were exercised by the 75-test file.

The original Native acceptance remains RED: complete login 394 <= 412, but first startup 183 > 139. No second pair, new Native run, narrower window, background subtraction, model switch or changed budget is part of this evidence. The complete 44-query difference is not claimed resolved.

## Resources and publication

The one 1-vCPU/2048-MiB sandbox had no public ports and was nonpersistent. It used only registry.npmjs.org and nodejs.org egress, had an initial 15-minute limit and one authorized five-minute extension for active tests/recovery, then was stopped, deleted and independently read as 404. Actual duration, CPU and transfer are in vm-cleanup.safe.json; no zero-cost claim is made. All original outputs were recovered and byte/hash checked before deletion.

The index distinguishes final candidate files from earlier experimental fixture/source files. Credential-shape and email scans found no hits. No credentials, real account content, artifact URLs, or production identifiers beyond public source/run references are included.
