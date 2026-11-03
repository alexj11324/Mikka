# Factory production acceptance and diagnostic skills — 2026-11-03

## Result and fixed environment

[Issue #1116](https://github.com/alexj11324/Mikka/issues/1116)'s no-repository delivery flow completed execute → independent review → independent verify → normal owner acceptance. The task stopped at approval/pending before the authorized acceptance request. This is real DeepSeek/E2B production evidence, separate from deterministic local tests.

- Application origin: `https://app.aspectlylabs.com/mikka`.
- Application revision: `56c5e0954ed10cad755df5387b67b2f7165e4e78`.
- Vercel deployment: `dpl_9RjRciX6EyF4yk3DBKGhRmXhC7yq` (READY before submission; `/api/version.build` matched before submission, observation and acceptance).
- Actual parent and task worker digest, read from `/opt/mikka/worker-source-sha`: `2223adc599c7994920195534ede039085965e262`.
- Main [CI 41634869119](https://github.com/alexj11324/Mikka/actions/runs/41634869119), [worker release 41634869077](https://github.com/alexj11324/Mikka/actions/runs/41634869077) and [daemon publish 41634869163](https://github.com/alexj11324/Mikka/actions/runs/41634869163): success.
- Existing smoke workspace: `0f877068-66a0-4893-8801-9a14eb3116b3`; existing Bot: `6160c8cb-090c-450c-a9ae-5b4b94f8bbb4`. Normal email sign-in used existing Infisical credentials in memory; no invented session, OAuth connection or production SQL mutation.
- Unique marker: `b396ba50`; submission ID: `a552c965-9f59-45b3-8874-211babbc66c0`.
- Factory task: `6632b340-921f-4c38-a92f-132f6b6e7c67`; candidate: `74ef9f13-a6bd-4757-8e09-430d9999a8ed`. Candidate kind is `deliverable`, public code SHA is null.

## Root causes and regression evidence

The resumed original task `5489a256-b53c-41eb-9cfd-8cc6ff34aa33` was blocked before native review with “Repository URL required; dispatch a new thread.” Its read-only claim correctly lacked interactive computer authority, but daemon workspace selection incorrectly required that authority. [#1117](https://github.com/alexj11324/Mikka/pull/1117) makes registered hosted workspace selection accept a read-only Factory check, retaining repository/origin ownership checks. See [startup diagnosis](2026-11-03-hosted-file-check-workspace.md).

The next fixed-version production task `99fbb8a6-d6e0-4ecc-a2cc-731931983e07` genuinely started review but entered two unnecessary repair loops: the read-only checker lacked a way to independently hash a file, then lacked host-recorded producer execution configuration. The owner cancelled that round normally before another code change. All real failures remain in its history; all five actual native assignments were confirmed `deepseek-flash` / `claude_code`. [#1120](https://github.com/alexj11324/Mikka/pull/1120) supplies confined read-only `inspect_artifact` observations and a minimal host execution projection; missing observations are blocked/help, not fabricated correctness failures. See [observation diagnosis and regression results](2026-11-03-independent-delivery-observations.md).

The MCP subprocess regression failed with the missing tool before the observation fix and passed afterward. The final local suite recorded 90 daemon/context/native-runner tests, 59 real isolated PostgreSQL 17 check/recovery tests and three prompt/recovery unit tests passing; application/daemon typechecks passed. Existing daemon lint warnings are documented in the linked audits. Both fix PRs passed their required CI before merge; the actual E2B development VM ran the relevant real-daemon regression before production release. These checks do not substitute for the production proof below. [#1115](https://github.com/alexj11324/Mikka/pull/1115)'s Flash policy also passed its current-head CI before merge.

## Independent sessions and artifact proof

| Stage | Run ID | Native session ID | Persisted result |
| --- | --- | --- | --- |
| execute | `0a0f2294-065a-4450-8afe-c88e7922daf0` | `b0520050-19b3-4a03-a3ef-6deeeec3f2fe` | passed / succeeded |
| review | `7503e062-64e3-451c-8695-a867b193f2b0` | `0d98acc2-0b04-4847-810b-3e23084f4363` | passed / succeeded |
| verify | `eda54323-de67-4175-8290-9dd077b70cc4` | `bedc9377-c09c-41e6-b0a7-b87d65e93040` | passed / succeeded |

The actual task VM `iqaiuxlxr0d2njerdfr1i` journal records all three native assignments as `deepseek-flash` with harness `claude_code`; each actual ID passed `node scripts/assert-test-model.mjs <modelId>`. The driver also preflighted the Bot's current model before sending the prompt. No Pro/other-model fallback occurred in these rounds. This establishes the exact configured Flash alias, not the version behind the alias or provider billing attribution (`observedModel` is null).

Both persisted independent reports explicitly cite `inspect_artifact` for the 400-byte file and matching hash/Git snapshot. Their `check.sha` values equal the trusted producer's `deliverableCommit`: `007d98ac97d2e59f916e63c437f42b11d0ecb56f`. They did not claim to run an unavailable native shell/`verify_command`; their report `verify.status` is `not_run`. Factory's independent-session/evidence gates nevertheless passed on the applicable file checks. The generic API reason mentioning “real command” does not establish a shell command executed.

Before acceptance, an additional host-side SDK read checked the **verifier's own actual worktree**, not only the producer:

- File: `/home/user/.mikka/worker/worktrees/eda54323-de67-4175-8290-9dd077b70cc4/lifecycle-smoke-b396ba50.txt`.
- Git HEAD and trusted retained delivery commit: `007d98ac97d2e59f916e63c437f42b11d0ecb56f`.
- File length: `400` bytes.
- Actual file SHA256 and `git show HEAD:lifecycle-smoke-b396ba50.txt` SHA256 both: `a76de96544daa6ff2b0922643271949d99a4254768c46fb731824eb48737e095`.
- Committed bytes exactly match actual file bytes; unique marker is present. The reviewer/verifier reports additionally record one marker occurrence at line 1, byte offset 21, and one stage sentence on each of lines 3, 5 and 7.

Retained UTF-8 contents (the test VM is disposable):

```text
Lifecycle Smoke Test b396ba50

派发环节：本任务已成功派发至本 Bot 自己的云端电脑并进入执行阶段。

执行环节：已仅使用 deepseek-flash（Flash）模型配合 Claude Code 完成文件创建，全程未切换 Pro 或其他模型。

移交环节：产出已交由 Factory 自动派发独立复核与独立验证，最终停在等待本人验收，未自行验收。
```

## Normal owner acceptance

The existing owner's normal session read `GET /api/factory/tasks/6632b340-921f-4c38-a92f-132f6b6e7c67/approval?view=ledger`, then submitted `POST .../approval` with operation `accept`, the exact returned binding and fresh event ID `eb0d1363-f0ee-431b-88f0-bef1e7f2c084`. The response was HTTP 200, `status=accepted`, acceptance ID `d1db4bff-6556-4e2f-bdd6-a5e3e75c8a76`. A fresh task read confirmed stage `approval`, status `passed`, and its passed approval attempt's persisted `output.deliverableAcceptanceId` matched. Neither the Bot nor a checker self-accepted.

## Scoped cleanup

After persisted acceptance, the normal owner machine API returned HTTP 200 / `state=ended` for all 16 known test run IDs from the handoff, the cancelled diagnostic round and the successful final round:

| Run ID | Machine API result |
| --- | --- |
| `f797eb88-4540-496e-8ba1-f445a7e8f1b3` | `ended` |
| `2fc36cbd-7c45-4d3c-84a3-c114dc2a5c89` | `ended` |
| `6c0afaf1-9824-4e07-86ed-b8bca08c8b79` | `ended` |
| `58a90524-d67a-471b-8276-f2cab098ce70` | `ended` |
| `9c0577a2-c9be-465d-8a02-708ea2df2e62` | `ended` |
| `68c527c1-1725-4946-86c4-32b5e6dce50f` | `ended` |
| `88281feb-c507-499f-8444-3083289bd602` | `ended` |
| `2f29f47c-948c-4087-8980-6242772cc209` | `ended` |
| `0a0f2294-065a-4450-8afe-c88e7922daf0` | `ended` |
| `7503e062-64e3-451c-8695-a867b193f2b0` | `ended` |
| `eda54323-de67-4175-8290-9dd077b70cc4` | `ended` |
| `feb32657-716c-49b8-8901-47ef623a82d8` | `ended` |
| `f18237ea-80a3-41fe-8b1d-6204cf592776` | `ended` |
| `4394da32-cb2e-4109-8335-4535b14efd54` | `ended` |
| `e8050103-f4d9-48ad-8773-7732839cef22` | `ended` |
| `5b2b957c-d23e-4b09-8ff8-234781829f24` | `ended` |

Only the owned final parent computer `iuqljrsg4ulhonx59uxm1` was paused through the SDK after its application/workspace metadata matched. Only the temporary model-key row `cb1271e5-8da0-40b2-8935-72e5fdae7534` and this test's workspace E2B key were removed through the existing normal settings server actions. Fresh settings API reads confirmed the model-key row absent (all other key IDs preserved) and E2B `configured=false`. The temporary cleanup driver's initial action-ID parser selected a neighboring action, which returned `validationGeneric` without removing the key; the parser was corrected and actual cleanup was verified. There was no product-code change for that driver error.

A final SDK listing scoped to the smoke workspace found only that paused parent; no test task VM remained. Bot/group/task records and failed-attempt history remain for audit. Infisical/provider credentials were not deleted. Protected Acme sandbox `ihuee6xcl4vvkox0lmpsz` was never connected to or mutated.

## Diagnostic skills used

Vendored `systematic-debugging` and `verification-before-completion` under `.claude/skills/`, with the MIT license in `.claude/skill-licenses/`, from `obra/superpowers` commit `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`. All ten Markdown files and the license have Git blob hashes identical to that pinned source. Executable examples are omitted under the existing project policy; README records this and maps TDD guidance to the existing project skill. `AGENTS.md` now points to both checklists while preserving the project's commit-bound CI reuse rules.

Applied here: trace the failure across API/claim/daemon/native/check-report boundaries; preserve the real failed round; reproduce before changing code; test the narrow root-cause fix; keep the production deployment fixed; inspect actual native sessions and verifier bytes; require persisted owner acceptance before claiming completion.

## Recovery boundary

The 13 original Flash-policy files are already committed in #1115 (head `531cc9ba6bd0dc7c7145276329d00e4c73bbcaab`, merged as `289c1cf54cf4d15989a87b92a5f6632cb7953ccc`). They are recoverable from GitHub and were not lost.

This environment's `/workspace/Mikka` is a fresh clone and `/workspace/Mikka-backend-final` is a newly created worktree. Neither is the original offline disk. Remote branches include historical WIP, but there is no verified matching copy of the original other-session/user uncommitted changes. Their contents cannot be reconstructed merely from GitHub commits. That recovery remains uncompleted; no reset/overwrite or claim of recovered original work is made. #1116 stays open for this explicit handoff item.
