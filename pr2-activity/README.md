# Live thinking and tool activity in the Bot chat (feat/coordinator-live-activity)

Local production build of 32976a1 at http://localhost:3000/mikka, isolated PostgreSQL 17 `mikka_e2e` on 127.0.0.1, owner from the test-account lease helper.
A scripted source streams the events the server now sends: `thinking` start/end, then `tool` events (running → done/error, with masked previews), then text. The runner then stores the turn as the workflow does (reasoning, tool calls and results, text, each with `mikkaStreamId`) and commits it. `repro-activity.mjs` is the runner.

`states.png`, left to right:
1. 思考中 (shimmer).
2. 思考了 3 秒, 建任务 ✓, 派发线程 running (shimmer).
3. A tool opened (输入 / 结果), with 派发线程 failed and the reply below it.
4. Stored: 已思考, the same tools and states, in the same row (`sameRow: true` in result.json).

The red 「Coordinator 暂时不可用」 line in the full frames comes from the local environment having no model configured.
