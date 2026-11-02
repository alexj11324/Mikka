# 本地 runs go to a server first, then the least busy device

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session after 「我的这个服务器是默认能跑的呀」: 「运行位置 · 本地」 dispatch puts servers first (online, 参与调度 on, deviceType server), then computers; devices of the same kind are ordered by a stable rule, not at random; the 本地 line shows 会先用 <设备名>, decided the same way as dispatch.
- Rule: —
- Replaces: in [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md), "One such computer is picked at random" (Dispatch, step 2, 本地).

**Which device takes a 本地 run.** Among the devices that can run the entry
(参与调度 on, online, the Agent installed and, for a subscription model, able
to take a subscription run; [1500](2026-11-02-1500-subscription-models-need-no-device-report.md)):

1. A server (deviceType server) before a computer.
2. Then the one with the fewest runs not yet ended (queued, preparing,
   running, paused, waiting for input, finishing).
3. Then the one that joined Mikka first, then by id.

Why fewest unfinished runs: threads run in parallel and no machine has a
Mikka cap (orchestration § 5), so the least busy device spreads concurrent
threads without randomness. The last time a device was seen is not used:
every online device reports within the same minute, so it would reorder
devices from one heartbeat to the next. Join order breaks ties so an idle
person's runs always land on the same device.

**会先用**: with 运行位置 本地, the line reads
`<N> 台电脑参与调度 · 会先用 <设备名>`: the device a new run would go to now,
computed by the same plan as dispatch (`planDispatch` and `pickDevice` in
`lib/model-order-plan.ts`) for 允许使用的模型 in order. When nothing can run,
the line has no 会先用.

A device the person names, or a thread continuing where it ran, is used as
asked, as before.
