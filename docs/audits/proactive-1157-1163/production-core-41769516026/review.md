# Production core 41769516026 — failure retained

The source and deployment were fixed to `5b81321dfd3bbc3413d71af258433e5e9ba73dfb` / `dpl_6iYpxckan3cxSfxcYg7Zs46cnVKW`. The active push head was `ff6b770f004a52747c65f68aa10f8856d4afba94`, using the reviewed prepared runner `875d86d6f28da4ad417298aaa90dde321b434a70`. The artifact ZIP and original JSON hashes were independently checked before this append. `results.json` is unchanged.

## Observed result

- Owner MCP management passed, including disabled no-auth fixture creation, personal-workspace sharing refusal and normal deletion/readback.
- Group acceptance failed on its first turn with `acceptance_turn_interrupted_generation_not_replayed`. The message was `56b841c7-baff-4078-9d82-76b1b51c668a` in group `1eda9418-3969-41fe-934f-7bad0de6f031`. Its retained routing chain was empty and its primary receipt was null. This is missing observation, not proof of no provider invocation or no charge.
- Independent replay stopped after baseline `small-talk`: phase `responder`, index 0, `invalid_decision`, reason `uncertain`. Execution receipt `32da2a35-9bc1-4117-99fa-9b278d2acc64`, generation `gen_01M6JAX0QAJEAGG7FYTW9M4EWZ`, timestamp 03:51:02.578–03:51:03.242 UTC. The host attached USD 0.000061 to this observed routing call. Candidate replay was not invoked. One receipted logical row is not a completed 24-case acceptance.

## Cleanup receipts

The new group was stopped once through the normal source-driver owner API. Stop acknowledged, stopped turns 0, and no pending retry remained; the turn had already failed. No delegation Task was present. No machine-end request was required. Do not stop this already acknowledged group again merely to collect another receipt.

All three independent sessions (owner MCP/replay, source group, temporary-credential helper) recorded login 200 and sign-out 200. Both temporary Flash and E2B credentials were created and removed by the helper. These cleanup successes do not change the failed acceptance result.

No raw prompt, answer, cookie, credential or private endpoint was copied into this review. No new production call, provider request or retry was made while reading and appending this evidence.
