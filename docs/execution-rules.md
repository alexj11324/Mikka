# Execution settings (retired)

Label execution rules, 任务默认, 「设备离线时」 and the 允许调度 / 允许自动调度
pair are gone. A new thread's model and machine now come from the person's
「允许使用的模型」 list, in their order, and 运行位置 (云端 / 本地), both on
Settings › 模型与订阅; each computer has one switch, 参与调度, on Settings › 设备.

- Decision: [`design/decisions/2026-11-02-1400-model-order-dispatch.md`](design/decisions/2026-11-02-1400-model-order-dispatch.md)
- Model, Agent and machine rules: [`design/orchestration.md`](design/orchestration.md) §3, §4
- Code: `lib/model-order-plan.ts` (the pure plan), `lib/model-order.ts`
  (list, candidates, credential state), `lib/model-dispatch.ts` (dispatch),
  `components/settings/model-order-settings.tsx` (the page)

The `execution_rules` table and `devices."autoSchedule"` are no longer read;
their rows were left in place.
