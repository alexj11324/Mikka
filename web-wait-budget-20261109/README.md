# E2B Web wait budget regression

This records a bounded release-gate fix for issue #1505, not a successful five-second cloud startup.

The 0415 release exhausted its 40-minute Web wait at 09:42:20.5328002 UTC on 2026-11-09. Its latest same-source Web job succeeded at 09:42:28. The original log and receipt are retained at commit 1cd5b7358be191dc4d6d5603342a0eac4b69f311 under runtime0415-await-web-20261109. The later a219 failure caused by a cancelled latest Web run is a separate case: that existing rejection remains correct and unchanged.

PR #1805 normal append 2c3edf02d630c88b092f21db47b6f312a3c26f96 extends only the E2B CLI's wait to 90 minutes and its job to 95. Desktop and the wait function's default stay at 40 minutes; explicit direct-call budgets stay in place. Latest-run selection, source fences, actual build/upload/version proof, and deadline refusal remain intact.

## Actual execution

Node v24.22.1 ran all 48 original tests successfully. The same expanded 51-test suite then ran against a neutral CLI helper extraction with the original 40-minute behavior: 49 passed and 2 failed for the expected timeout/deadline behavior. This RED source is preserved and is not described as byte-identical to 37ff. The four final changed files produced 51 passes, 0 failures, and a clean git diff --check. Three fake-clock tests exercise the latest queued Web completing at 40 minutes 10 seconds, Desktop stopping at 40 minutes, and missing Web proof stopping at 90 minutes without public-version reads.

All full logs were recovered before stopping the one-vCPU development VM, then validated by byte counts and SHA-256. The stop and independent GET both report stopped. This fixture uses the nine exact source/workflow files listed in source-manifest.json and the operation guide; it is not a full repository install and contains no production credentials. Remote CI belongs to the new PR head and is recorded separately when complete.

No production model/Task was created. New formal CC×3/CX×3 samples remain zero and the 5000ms criterion remains unchanged.
