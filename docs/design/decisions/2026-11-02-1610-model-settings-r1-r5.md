# 模型与订阅 and 设备: R1, R2, R3, R5

- Date: 2026-11-02
- Source: Alex accepted the coordination draft (Artifact NXhjpSTmgDq1aVNqzLYP2x, Version 2; Figma zPe5LKycb2XuT1ivCLRw07, page 834:2, R1 872:2 / 872:263, R2 872:37 / 872:298, R3 872:127 / 872:388, R5 872:206 / 872:467), relayed by the coordinator session.
- Rule: R-23 (cloud without a key offers 填入 E2B Key), R-40, R-51
- Replaces: the separate 「云电脑」 section of 模型与订阅; the confirmation before 移除 in [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md) ("removes them (with a confirmation)").

**R1 · 运行位置.** What fixes or explains the run location is on its row.
本地: 「N 台电脑参与调度 · 会先用 <设备名>」
([1530](2026-11-02-1530-local-server-first.md)) and 打开设备 (设置 › 设备).
云端 without the person's E2B key: 「还没有 E2B Key」 and 填入 E2B Key, which
opens the key dialog; with a key, 更换 E2B Key. The separate 「云电脑」
section is gone.

**R2 · Order from the row menu, undo instead of confirm.** Each row's menu:
移到最前 · 上移 · 下移, then 移出列表. 移出列表 takes effect at once and the
toast 「已移出 <model> · 撤销」 puts the model back where it was. Adding it
back is cheap, so it is undone rather than confirmed; disconnecting a
subscription or deleting an API key still asks first (R-51). The keyboard
instructions are announced to screen readers, not written on the page.

**R3 · 顺序未保存.** A reorder that is not saved puts the list back as saved
and marks the moved row 「顺序未保存」 with 重试, instead of an error line at
the bottom. A used-up subscription's row reads 「额度用完 · <date time> 恢复」.

**R5 · What a device can run.** Under each device on 设置 › 设备: the allowed
models of this workspace its Agents can run (「能跑 a、b」, or
「能跑 N 个允许使用的模型」 past two, or 「不能跑允许使用的模型」), whatever its
参与调度 says; offline, 「离线 · 不会被派任务」. It is read from the same view as
模型与订阅 (`deviceModels` in `lib/model-order.ts`, `deviceModel` in
`lib/model-order-plan.ts`).

R4 (the 「这个工作区 · 分享给团队成员」 section) belongs to the per-row share
switches, built in the sharing change.
