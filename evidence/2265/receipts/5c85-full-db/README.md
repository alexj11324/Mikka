# Original conversation baseline database tests

The public [source commit](https://github.com/alexj11324/Mikka/commit/5c85ee16410fe5586ad6fef708e8630ef67fe1c3) is `5c85ee16410fe5586ad6fef708e8630ef67fe1c3`, tree `e0a1b294790ffda17cf089fa3b78571dbb70a40b`.

An isolated GitHub Ubuntu 22.04 runner ran `pnpm test:db` with PostgreSQL 17 and `MIKKA_EDITION=cloud` from 2026-11-15T02:26:27Z to 2026-11-15T02:39:37Z. Both `DB_TEST_SHARD` and `DB_TEST_SELECTED` were unset. The login fixture, the deployment marker and the source checkout used the same baseline SHA. [Workflow job](https://github.com/alexj11324/Mikka/actions/runs/43667642114/job/132670483904)

The original inventory enrolled 86 package scripts with 394 distinct database test files. The package scripts also cover related unit cases. The original runner reported 4,875 tests (4,875 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled) and pnpm exit 0. 86 suites reported their start, zero process exit and zero stream close. The bootstrap, local-execution identities and thread membership/privacy integration ran in separate setup steps.

The inventory identifies 7 files owned by separate runners, 2 browser inputs and 4 offline-guarded inputs. Their declaration checks run as part of this command. Their separate test commands have their own evidence.

The ZIP digest published by GitHub is `sha256:0b202ec26815a5003fb9b627464415e172295eaf6e7599299c6a6c22d89249b5`. [Downloadable run artifact](https://github.com/alexj11324/Mikka/actions/runs/43667642114/artifacts/14143501319)

The adjacent full-direct-receipt.json records each package command, process result and elapsed time, the file-to-command mapping, and the per-suite counts. The compressed named-checks.jsonl.gz retains timestamped test-runner case lines and counters. Each line includes the package script that emitted it.

## Required pull-request checks

The required workflow normally accepts a path-selected suite list. This pull request selected the full inventory across four shards. All four jobs tested GitHub’s merge commit `959617106028ae8518ad40f605596fffc2c22118`, whose tree is identical to the tested direct commit. The following job times are the database-command step, in UTC.

| Shard | Package scripts | Passed tests | Started | Ended | Job |
| --- | ---: | ---: | --- | --- | --- |
| 1/4 | 22 | 730 | 2026-11-15T01:06:11Z | 2026-11-15T01:09:00Z | [Job 132651026193](https://github.com/alexj11324/Mikka/actions/runs/43661235548/job/132651026193) |
| 2/4 | 22 | 1,399 | 2026-11-15T01:05:40Z | 2026-11-15T01:10:43Z | [Job 132651026138](https://github.com/alexj11324/Mikka/actions/runs/43661235548/job/132651026138) |
| 3/4 | 21 | 861 | 2026-11-15T01:05:51Z | 2026-11-15T01:08:37Z | [Job 132651026122](https://github.com/alexj11324/Mikka/actions/runs/43661235548/job/132651026122) |
| 4/4 | 21 | 1,885 | 2026-11-15T01:05:41Z | 2026-11-15T01:12:24Z | [Job 132651026110](https://github.com/alexj11324/Mikka/actions/runs/43661235548/job/132651026110) |
