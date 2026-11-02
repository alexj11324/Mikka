# PR #1076 evidence: Bot chat streaming flicker and chip markup

Local production build (`next build` + `next start`) at http://localhost:3000/mikka, isolated PostgreSQL 17 `mikka_e2e` on 127.0.0.1, owner identity from the test-account lease helper (`scripts/test-accounts/session.mjs`).
Seed: 4 stored replies, each with two task chips and a table, then the person's question. The reply streams into the real chat from a scripted token source (uneven batches of 1/3/2/5/4 characters, 60 ms apart). It cites a task the chat already knows and a task created in that turn. Then the runner stores the reply with its `mikkaStreamId`, ends the lease and sends `committed`, as the workflow does. `repro.mjs` is the runner.

| | before (a37573b, main) | after (06caf59, PR head) |
| --- | --- | --- |
| chips in finished messages unmounted while streaming | 488 | 0 |
| lowest opacity of a finished chip while streaming | 0 | 0.93 (one-time fade-in on page load) |
| frames showing `[[issue:` / an id in the live reply | 40+ | 0 |
| chip for the task created that turn while streaming | raw marker | chip, resolved during the stream |
| at store: same row element kept | no (row replaced) | yes |
| at store: chips unmounted / lowest opacity | 48 / 0 | 0 / 1 |

`*-handoff.png`: 8 frames, every second frame from 2 before `committed` onwards. Before: raw marker, then every chip goes blank and fades back in. After: nothing changes.
The red 「Coordinator 暂时不可用」 line is the local environment having no model configured; it shows in both runs.
