# A43 attempt02：启动超时、预加载 PID 与 task VM 复用

固定源码：生产 `1846002bec14c649e4bead67f136014141f4d133`。只读分析，未执行重试、模型、sandbox 命令、产品修改或生产写入。

## 结论

第一次 `install_computer` 超时已由同一个 durable handoff 的正常内部重试恢复，不构成本次仍未解决的启动故障。`preloaded.pid` 缺失是可选预加载分支的诊断输出，命令有明确正常启动 fallback；该行本身不是 worker 启动失败的证据。后续数据库已证明真实 native claim，不能再以此前 queued/error 的瞬时状态代表现状。

实际是新 review run、新 native SID，以及同一任务 artifact VM 的保留和转移；没有创建新 VM。

## 事实时间线（UTC）

| 时间 | 已观测事实 |
| --- | --- |
| 00:00:58.332 | Owner recheck 回执 `6c485476-b3b5-4d1e-a7e7-47865d34affa` 提交；新 review `af4309f0-c48f-463a-8552-1b04c6e33595`。 |
| 00:01:18.681 | Vercel `thread_runtime_start_failed`，phase=`install_computer`、class=`TimeoutError`、code=`unknown`。 |
| 00:01:20.406 | 同一 run 的正常 workflow 再次 handoff，`providerContinuation=false`；没有第二次 Owner 点击。 |
| 00:01:55 | 首个状态样本仍 queued，SID/start/native claim/lease NULL，thread machine error。 |
| 00:02:11.746 | worker 输出 `/home/user/.mikka/preloaded.pid: No such file or directory`。 |
| 00:02:17.019 | 后续日志 `factory_cloud_handoff_finished`、`started=true`（根任务直接读取的 runtime-second 原件）。 |
| 00:03:54.387 | 直接读取 sample02 原件：run running，`startedAt=00:02:17.934`、新 SID `0c6512df-0df0-460a-92d0-6aea0a963033`、native binding `0e5edf2d-2653-475e-8693-b53ceafa7c11`、`apiClaim=false`。 |

样本中的 thread machine `runningSince=00:02:17.011`；sandbox 仍为 `i773iwx0ulev7nvbomyyk`。父 Bot sandbox 是另一个 `ipa60du803guuiqnyzqan`，仍 sleeping。前后不能将 UI 的 review/running 标签替代真实 claim；本报告的 claim 结论来自 sample02 的 run/native 字段。

原件：`attempt02-runtime-initial-response.json`、`attempt02-runtime-initial-relevant.md`、`attempt02-runtime-second-response.json`、`attempt02-sample01-response.json`、`attempt02-sample02-response.json`。

## 源码解释

`lib/computer/e2b-provider.ts:72–95` 的 `installComputerRuntime` 负责校验/必要时更新 viewer 与 lease guard 两个脚本并启动 viewer gateway。两次候选 command 各使用 10 秒上限；现有日志仅定位该阶段发生 TimeoutError，没有证明具体是文件传输、gateway 等待还是远端命令通道超时。成功的后续内部重试已经解决本次启动症状，不据此虚构持久产品缺陷。

`lib/computer/worker-command.ts:3` 读取 `preloaded.pid` 失败时执行 `|| preload_pid=`。若没有活着的 `--wait-bootstrap` 进程，就运行已编译的 `dist/cloud/cloud-worker.js`，或旧 snapshot 的 tsx 入口。`packages/daemon/bin/cloud-worker.ts:24–33` 只在 `--wait-bootstrap` 分支写该 PID 文件，并在进程退出时删除；普通启动不要求该文件。因此缺失 PID 不表示 bootstrap 凭据缺失，也不表示没有正常 fallback。

`lib/cloud-computer/thread-machines.ts:171–206` 明确实现同一 task 保留自己的 sandbox。adopt 条件包括同 owner、workspace、issue、repo，旧 run 为终态、机器 paused、没有有效 worker lease；旧 row ended 并交出 sandbox，新 row 接收同 sandbox/device/repo。`474–492` 再校验新 run 仍 queued、机器空闲和租约条件。失败处理 `750–754` 保留原 sandbox，清理启动 lease，将尚未 claim 的 row 记为 error，并返回可由 durable workflow 重试的 retained-runtime 错误。

`lib/factory/cloud-stage-handoff.ts:35–48` 对已经 claim 的 run 不再次 bootstrap；对 queued run 启动失败保留 task history 并重试 durable step。当前观察与此路径一致。

## fresh VM 文案的明确更正

根任务重新确认原 Takeover 的 fresh VM 要求针对前面四个 NEW tasks，没有要求 A43 同一 candidate 的每次 review/verify 阶段重新创建 VM。准备材料若把 A43 的 fresh session 加强写成 fresh VM，必须作为准备阶段假设更正并保留痕迹，不能用新 SID 隐含宣称新 VM。

`lib/factory/check-start-recovery.ts:148–159` 强制新 acceptance 在排队时的 `startedAt/sessionId/leaseExpiresAt/retryOf/continuesRunId/questionContinuation` 等为 NULL，同时保留冻结 candidate/role/command/source；它没有要求新 sandbox。最终验收准确表述应为：新 run、新 native SID，复用同一任务的保留 artifact VM，父 Bot runtime 保持 sleeping。

这份记录只分类启动事实。后续 review/verify 报告的语义通过与否、Owner accept 与最终验收由独立证据审阅决定；没有因启动成功而认定任务完成。
