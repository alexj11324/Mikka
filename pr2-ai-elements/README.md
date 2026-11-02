# Live thinking and tools with AI Elements (e3b2013)

Local production build of e3b2013 (`next build`, `next start`) at http://localhost:3000/mikka, isolated PostgreSQL 17 `mikka_e2e` on 127.0.0.1, owner from the test-account lease helper. `repro-activity.mjs` is the runner. The turn's events come from a scripted source, and the stored rows follow the workflow's format.

The demo turn creates a task, dispatches its thread to the cloud (E2B) successfully, and shows a failed state on a tool that has nothing to do with dispatching (查看日历: Google Calendar 未连接).

`states.png`, left to right:
1. 思考中 (Shimmer) and the working line.
2. 思考了 3 秒, 建任务 完成, 派发线程 进行中.
3. A Tool opened, showing 输入 / 结果 in CodeBlock; 派发线程 完成, 查看日历 失败.
4. Stored: 已思考, the same Tools and states, in the same row (`sameRow: true`).

Environment: the server ran with `MIKKA_TEST_MODE=1 MIKKA_MVP_E2E=1`, the existing local test mode (`lib/run-test-fixture.ts`). That mode applies only to a loopback `mikka_e2e` with local test accounts. It makes `coordinatorEnabled()` true without a model key, so the chat shows the real working line and stop button instead of 「Coordinator 暂时不可用」. No model is called; the stream is scripted.

Components: AI Elements 1.9.1 from registry.ai-sdk.dev (tool, reasoning, shimmer, code-block), fetched 2026-11-02. Each file in components/ai-elements/ lists its differences from upstream at the top.
