# #1505 生产启动基线：2026-11-06

六条真实生产任务已完成，两种订阅各三次；这是优化前的测量证据，**不是 ≤5 秒验收通过**。任务通过正常 ACME 登录与 Coordinator，在 `alexj11324/Mikka-handoff` 读取仓库并返回唯一标记；六次都有真实订阅回复、完成的工具调用及成功清理。

## 原始证据与边界

- [生产工作流](https://github.com/alexj11324/Mikka/actions/runs/42289116652)；[原始脱敏 artifact](https://github.com/alexj11324/Mikka/actions/runs/42289116652/artifacts/13540515389)。工作流提交 `d1a360e12fad3b208c725b4f66b3640d0bb891fd`。
- [闭集数字 JSON](2026-11-06-cloud-startup-production-baseline.json)保留六个 run hash、workflow ID、222 条 server 分段、daemon 子阶段与每次已观察到的原生调用。
- 14 次应用/worker 配置检查一致；六个 VM 已结束，六个测试任务已删除，临时 Profile 已归档，正常 signout，无清理错误。任务指令明确禁止改文件、提交、推分支和创建 PR。
- [该版本 dispatchRun](https://github.com/alexj11324/Mikka/blob/c0c98baa3020a085652ee5f773310b6dfa412c5d/workflows/coordinator/steps.ts)的计时从函数内部开始，漏掉前面的 workspace/Profile/授权准备。因此本文所有启动秒数都是 `legacy_dispatch_body` 到既有 stage 的**下界**，不能换称整个派发入口耗时。未获得可关联的旧 workflow span，完整旧入口保持 unavailable。
- 旧 worker 没有官方首提示确认收据。最终 [PR #1523](https://github.com/alexj11324/Mikka/pull/1523) 验收要求 `boundary=dispatch_run_entry`，Claude 首提示 exact UUID 的 `claude_user_ack` 或 Codex `turn/start` ACK，并取与旧 stage 中较晚的一项；不能用 CLI ready 提前过门槛。

## #1505 生产云启动测量

状态：**baseline_recorded**。模式：`baseline`；策略标签：`official`。

应用 commit：`c0c98baa3020a085652ee5f773310b6dfa412c5d`。worker SHA：`ca9057a1bb71fa3cdf80c30c9c9156b76bcad2ef`；worker source：`2960d783f0196fed5375593d910a43430a101747`。
部署：`dpl_7pKfeLGuConuD2B3FEfUtQFisfGW`。日志查询：`query_complete`。

时长单位为秒。起点取对应 workflow 的 dispatch_timing.startedAt；只有 boundary=dispatch_run_entry 才是 dispatchRun 函数入口。缺少该标记的旧版本起点为 legacy_dispatch_body，仅保留耗时下界，不能通过最终 ≤5 秒验收。agent_start 与首实际 provider/tool chunk 使用服务端存储时点；实际官方任务 ACK 使用同进程单调时钟差加到 stage 收据上。旧 worker 缺少 ACK 时明确留空。

| Sample | Harness | 起点边界 | Run hash | 起点→agent_start | 起点→真实接收上界 | 起点→首 provider/tool chunk | 清理 | 分组资格 |
|---|---|---|---|---:|---:|---:|---|---|
| 87f4fd2f_1 | claude_code | legacy_dispatch_body | `ec4178a2eab526af` | 91.989 | — | 99.488 | passed | 有效单样本 |
| 87f4fd2f_2 | codex | legacy_dispatch_body | `eb8ce980036d4b0a` | 80.400 | — | 88.640 | passed | 有效单样本 |
| 87f4fd2f_3 | claude_code | legacy_dispatch_body | `648841f1b8cafaf8` | 82.528 | — | 89.942 | passed | 有效单样本 |
| 87f4fd2f_4 | codex | legacy_dispatch_body | `12fcd8a11eb7fa4e` | 84.270 | — | 92.112 | passed | 有效单样本 |
| 87f4fd2f_5 | claude_code | legacy_dispatch_body | `b2343f8acd89f5ef` | 94.567 | — | 103.322 | passed | 有效单样本 |
| 87f4fd2f_6 | codex | legacy_dispatch_body | `b58d73228d9da0a4` | 90.430 | — | 98.051 | passed | 有效单样本 |

### 分组统计

| Harness | n | agent_start median / max | 首 provider/tool chunk median / max |
|---|---:|---:|---:|
| claude_code | 3 | 91.989 / 94.567 | 99.488 / 103.322 |
| codex | 3 | 84.270 / 90.430 | 92.112 / 98.051 |

### 启动分段

父子阶段和并行阶段会重叠，不能跨行求和。claim.native_credentials / github_credentials 与 assignment_context / credentials_wait 也可能重叠。相同 daemon 阶段在一轮内取区间并集；同名串行 server 阶段合计。缺失值不补零；小样本不计算 P95。

#### claude_code

| 阶段 | 87f4fd2f_1 | 87f4fd2f_3 | 87f4fd2f_5 | median | max |
|---|---:|---:|---:|---:|---:|
| `bootstrap.build` | 0.509 | 0.477 | 0.642 | 0.509 | 0.642 |
| `bootstrap.cli` | 5.435 | 5.086 | 5.653 | 5.435 | 5.653 |
| `bootstrap.dependencies` | 42.305 | 35.923 | 45.940 | 42.305 | 45.940 |
| `bootstrap.desktop` | 0.001 | 0.000 | 0.000 | 0.000 | 0.001 |
| `bootstrap.finalize` | 0.796 | 0.679 | 0.817 | 0.796 | 0.817 |
| `bootstrap.gh` | 0.791 | 0.771 | 0.874 | 0.791 | 0.874 |
| `bootstrap.journal` | 0.192 | 0.104 | 0.204 | 0.192 | 0.204 |
| `bootstrap.node` | 2.827 | 2.616 | 2.951 | 2.827 | 2.951 |
| `bootstrap.source` | 3.950 | 3.773 | 3.548 | 3.773 | 3.950 |
| `bootstrap.validation` | 0.011 | 0.030 | 0.016 | 0.016 | 0.030 |
| `cloud.sandbox.bootstrap` | 57.011 | 49.652 | 60.817 | 57.011 | 60.817 |
| `cloud.sandbox.create` | 0.448 | 0.427 | 0.350 | 0.427 | 0.448 |
| `cloud.sandbox.credentials` | 0.027 | 0.028 | 0.026 | 0.027 | 0.028 |
| `cloud.thread.admission` | 0.126 | 0.138 | 0.130 | 0.130 | 0.138 |
| `cloud.thread.connect` | 57.487 | 50.107 | 61.194 | 57.487 | 61.194 |
| `cloud.thread.credential_bootstrap` | 0.304 | 0.317 | 0.317 | 0.317 | 0.317 |
| `cloud.thread.ensure` | 59.694 | 53.139 | 63.714 | 59.694 | 63.714 |
| `cloud.thread.execution_identity` | 0.066 | 0.079 | 0.067 | 0.067 | 0.079 |
| `cloud.thread.finish` | 0.015 | 0.014 | 0.014 | 0.014 | 0.015 |
| `cloud.thread.post_connect_admission` | 0.037 | 0.040 | 0.040 | 0.040 | 0.040 |
| `cloud.thread.publish_bootstrap` | 0.225 | 0.224 | 0.216 | 0.224 | 0.225 |
| `cloud.thread.read_refreshed_worker` | 0.067 | 0.072 | 0.242 | 0.072 | 0.242 |
| `cloud.thread.read_worker` | 0.087 | 0.099 | 0.092 | 0.092 | 0.099 |
| `cloud.thread.record_sandbox` | 0.012 | 0.773 | 0.126 | 0.126 | 0.773 |
| `cloud.thread.runtime_configuration` | 0.001 | 0.001 | 0.001 | 0.001 | 0.001 |
| `cloud.thread.start_desktop` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.start_worker` | 0.217 | 0.220 | 0.222 | 0.220 | 0.222 |
| `cloud.thread.verify_refreshed_worker` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.verify_runtime` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.verify_worker` | 0.000 | 0.000 | 0.001 | 0.000 | 0.001 |
| `cloud.thread.worker_register` | 1.044 | 1.045 | 1.040 | 1.044 | 1.045 |
| `daemon.adapter.account_check` | 2.957 | 3.526 | 3.361 | 3.361 | 3.526 |
| `daemon.adapter.account_check.account_info` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `daemon.adapter.auth` | 9.125 | 9.734 | 10.009 | 9.734 | 10.009 |
| `daemon.adapter.auth.broker` | 3.024 | 3.185 | 3.583 | 3.185 | 3.583 |
| `daemon.adapter.auth.context` | 7.833 | 8.132 | 8.283 | 8.132 | 8.283 |
| `daemon.adapter.auth.gate` | 7.217 | 6.950 | 6.974 | 6.974 | 7.217 |
| `daemon.adapter.cli_init` | 0.605 | 0.548 | 0.646 | 0.605 | 0.646 |
| `daemon.adapter.model_report` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `daemon.adapter.start` | 16.295 | 16.306 | 16.625 | 16.306 | 16.625 |
| `daemon.adapter.workspace.read_tree` | 0.005 | 0.008 | 0.007 | 0.007 | 0.008 |
| `daemon.adapter.workspace.shadow_clone` | 0.020 | 0.020 | 0.023 | 0.020 | 0.023 |
| `dispatch.authorizeSubscriptionWorkspace` | 0.033 | 0.044 | 0.035 | 0.035 | 0.044 |
| `dispatch.bindAgentToConnection` | 0.031 | 0.029 | 0.029 | 0.029 | 0.031 |
| `dispatch.ensureBotCloudRuntime` | 0.125 | 0.113 | 0.116 | 0.116 | 0.125 |
| `dispatch.ensureDeviceRepository` | 0.062 | 0.056 | 0.064 | 0.062 | 0.064 |
| `dispatch.ensureThreadMachine` | 59.695 | 53.140 | 63.715 | 59.695 | 63.715 |
| `dispatch.executionWorkspace` | 0.047 | 0.058 | 0.048 | 0.048 | 0.058 |
| `dispatch.issueForUser` | 0.076 | 0.089 | 0.076 | 0.076 | 0.089 |
| `dispatch.queueCloudRun` | 1.835 | 1.712 | 1.682 | 1.712 | 1.835 |
| `dispatch.resolveModelDispatch` | 0.678 | 0.663 | 0.638 | 0.663 | 0.678 |
| `dispatch.resolveRepository` | 0.800 | 0.750 | 0.818 | 0.800 | 0.818 |
| `dispatch.runPlacement` | 0.014 | 0.014 | 0.014 | 0.014 | 0.014 |
| `dispatch.startLifecycle` | 0.082 | 0.132 | 0.204 | 0.132 | 0.204 |

#### codex

| 阶段 | 87f4fd2f_2 | 87f4fd2f_4 | 87f4fd2f_6 | median | max |
|---|---:|---:|---:|---:|---:|
| `bootstrap.build` | 0.504 | 0.504 | 0.545 | 0.504 | 0.545 |
| `bootstrap.cli` | 0.927 | 0.947 | 1.126 | 0.947 | 1.126 |
| `bootstrap.dependencies` | 36.799 | 40.708 | 45.938 | 40.708 | 45.938 |
| `bootstrap.desktop` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `bootstrap.finalize` | 0.717 | 0.764 | 0.819 | 0.764 | 0.819 |
| `bootstrap.gh` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `bootstrap.journal` | 0.179 | 0.198 | 0.138 | 0.179 | 0.198 |
| `bootstrap.node` | 2.851 | 2.932 | 3.347 | 2.932 | 3.347 |
| `bootstrap.source` | 4.095 | 4.458 | 5.495 | 4.458 | 5.495 |
| `bootstrap.validation` | 0.033 | 0.023 | 0.038 | 0.033 | 0.038 |
| `cloud.sandbox.bootstrap` | 46.231 | 50.680 | 57.562 | 50.680 | 57.562 |
| `cloud.sandbox.create` | 0.429 | 0.500 | 0.431 | 0.431 | 0.500 |
| `cloud.sandbox.credentials` | 0.023 | 0.023 | 0.024 | 0.023 | 0.024 |
| `cloud.thread.admission` | 0.132 | 0.137 | 0.280 | 0.137 | 0.280 |
| `cloud.thread.connect` | 46.683 | 51.204 | 58.018 | 51.204 | 58.018 |
| `cloud.thread.credential_bootstrap` | 0.309 | 0.305 | 0.326 | 0.309 | 0.326 |
| `cloud.thread.ensure` | 49.172 | 53.532 | 60.745 | 53.532 | 60.745 |
| `cloud.thread.execution_identity` | 0.074 | 0.077 | 0.153 | 0.077 | 0.153 |
| `cloud.thread.finish` | 0.014 | 0.013 | 0.017 | 0.014 | 0.017 |
| `cloud.thread.post_connect_admission` | 0.041 | 0.041 | 0.042 | 0.041 | 0.042 |
| `cloud.thread.publish_bootstrap` | 0.387 | 0.210 | 0.211 | 0.211 | 0.387 |
| `cloud.thread.read_refreshed_worker` | 0.067 | 0.066 | 0.241 | 0.067 | 0.241 |
| `cloud.thread.read_worker` | 0.104 | 0.142 | 0.129 | 0.129 | 0.142 |
| `cloud.thread.record_sandbox` | 0.086 | 0.092 | 0.015 | 0.086 | 0.092 |
| `cloud.thread.runtime_configuration` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.start_desktop` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.start_worker` | 0.206 | 0.195 | 0.249 | 0.206 | 0.249 |
| `cloud.thread.verify_refreshed_worker` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.verify_runtime` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.verify_worker` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `cloud.thread.worker_register` | 1.040 | 1.042 | 1.051 | 1.042 | 1.051 |
| `daemon.adapter.account_check` | 3.176 | 3.015 | 2.899 | 3.015 | 3.176 |
| `daemon.adapter.auth` | 8.818 | 8.912 | 8.762 | 8.818 | 8.912 |
| `daemon.adapter.auth.broker` | 2.925 | 2.962 | 3.028 | 2.962 | 3.028 |
| `daemon.adapter.auth.context` | 7.017 | 7.876 | 7.405 | 7.405 | 7.876 |
| `daemon.adapter.auth.gate` | 7.109 | 6.943 | 6.812 | 6.943 | 7.109 |
| `daemon.adapter.cli_init` | 0.178 | 0.433 | 0.226 | 0.226 | 0.433 |
| `daemon.adapter.model_report` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `daemon.adapter.start` | 15.483 | 16.598 | 15.388 | 15.483 | 16.598 |
| `daemon.adapter.workspace.read_tree` | 0.006 | 0.005 | 0.006 | 0.006 | 0.006 |
| `daemon.adapter.workspace.shadow_clone` | 0.022 | 0.018 | 0.019 | 0.019 | 0.022 |
| `dispatch.authorizeSubscriptionWorkspace` | 0.046 | 0.042 | 0.047 | 0.046 | 0.047 |
| `dispatch.bindAgentToConnection` | 0.029 | 0.023 | 0.032 | 0.029 | 0.032 |
| `dispatch.ensureBotCloudRuntime` | 0.220 | 0.093 | 0.124 | 0.124 | 0.220 |
| `dispatch.ensureDeviceRepository` | 0.059 | 0.045 | 0.061 | 0.059 | 0.061 |
| `dispatch.ensureThreadMachine` | 49.172 | 53.534 | 60.746 | 53.534 | 60.746 |
| `dispatch.executionWorkspace` | 0.054 | 0.052 | 0.063 | 0.054 | 0.063 |
| `dispatch.issueForUser` | 0.086 | 0.078 | 0.097 | 0.086 | 0.097 |
| `dispatch.queueCloudRun` | 1.797 | 1.490 | 1.951 | 1.797 | 1.951 |
| `dispatch.resolveModelDispatch` | 0.735 | 0.545 | 0.733 | 0.733 | 0.735 |
| `dispatch.resolveRepository` | 0.875 | 0.865 | 0.743 | 0.865 | 0.875 |
| `dispatch.runPlacement` | 0.016 | 0.014 | 0.017 | 0.016 | 0.017 |
| `dispatch.startLifecycle` | 0.080 | 0.129 | 0.107 | 0.107 | 0.129 |

### 每次原生 provider 代理调用

准备成本是 Mikka 已测得的开销下限；provider_headers 含上游首响应时间，不能称作纯代理开销，也不能与包含它的 HTTP 父阶段相加。

| Sample / call | 准备成本下限 | Provider headers（含上游） | Service total | Outcome | Trace ID |
|---|---:|---:|---:|---|---|
| 87f4fd2f_1 / 1 | 0.518 | 3.014 | 3.533 | ok | `2eac68eee417e51db99022e6074538b5` |
| 87f4fd2f_1 / 2 | 0.671 | 1.813 | 2.484 | ok | `2eac68eee417e51db99022e6074538b5` |
| 87f4fd2f_1 / 3 | 0.625 | 1.534 | 2.159 | ok | `2eac68eee417e51db99022e6074538b5` |
| 87f4fd2f_1 / 4 | 0.532 | 1.545 | 2.077 | ok | `2eac68eee417e51db99022e6074538b5` |
| 87f4fd2f_1 / 5 | 0.561 | 1.704 | 2.265 | ok | `2eac68eee417e51db99022e6074538b5` |
| 87f4fd2f_1 / 6 | 0.633 | 2.302 | 2.935 | ok | `2eac68eee417e51db99022e6074538b5` |
| 87f4fd2f_2 / 1 | 0.621 | 2.083 | 2.704 | ok | `e48519af2758053579dccb74f355835b` |
| 87f4fd2f_2 / 2 | 0.786 | 1.794 | 2.580 | ok | `e48519af2758053579dccb74f355835b` |
| 87f4fd2f_2 / 3 | 2.045 | 2.172 | 4.218 | ok | `e48519af2758053579dccb74f355835b` |
| 87f4fd2f_2 / 4 | 0.575 | 1.817 | 2.392 | ok | `e48519af2758053579dccb74f355835b` |
| 87f4fd2f_2 / 5 | 0.765 | 2.013 | 2.778 | ok | `e48519af2758053579dccb74f355835b` |
| 87f4fd2f_3 / 1 | 0.624 | 2.188 | 2.812 | ok | `ec546df4a99dcf6b89a983988ace0b55` |
| 87f4fd2f_3 / 2 | 0.714 | 1.887 | 2.601 | ok | `ec546df4a99dcf6b89a983988ace0b55` |
| 87f4fd2f_3 / 3 | 0.625 | 2.480 | 3.105 | ok | `ec546df4a99dcf6b89a983988ace0b55` |
| 87f4fd2f_3 / 4 | 0.574 | 2.529 | 3.103 | ok | `ec546df4a99dcf6b89a983988ace0b55` |
| 87f4fd2f_3 / 5 | 0.628 | 1.970 | 2.597 | ok | `ec546df4a99dcf6b89a983988ace0b55` |
| 87f4fd2f_3 / 6 | 0.609 | 2.229 | 2.839 | ok | `ec546df4a99dcf6b89a983988ace0b55` |
| 87f4fd2f_4 / 1 | 0.664 | 1.762 | 2.426 | ok | `5b2a03549dd9e1c410a71dac880bf60a` |
| 87f4fd2f_4 / 2 | 0.607 | 1.941 | 2.548 | ok | `5b2a03549dd9e1c410a71dac880bf60a` |
| 87f4fd2f_4 / 3 | 1.943 | 2.215 | 4.159 | ok | `5b2a03549dd9e1c410a71dac880bf60a` |
| 87f4fd2f_4 / 4 | 0.613 | 2.158 | 2.770 | ok | `5b2a03549dd9e1c410a71dac880bf60a` |
| 87f4fd2f_4 / 5 | 0.605 | 2.575 | 3.180 | ok | `5b2a03549dd9e1c410a71dac880bf60a` |
| 87f4fd2f_5 / 1 | 0.706 | 1.363 | 2.070 | ok | `1e125a7796a0f0012dc2974a2e2d8d2a` |
| 87f4fd2f_5 / 2 | 0.773 | 2.221 | 2.995 | ok | `1e125a7796a0f0012dc2974a2e2d8d2a` |
| 87f4fd2f_5 / 3 | 0.719 | 1.723 | 2.442 | ok | `1e125a7796a0f0012dc2974a2e2d8d2a` |
| 87f4fd2f_5 / 4 | 2.038 | 1.735 | 3.773 | ok | `1e125a7796a0f0012dc2974a2e2d8d2a` |
| 87f4fd2f_5 / 5 | 0.659 | 2.478 | 3.137 | ok | `1e125a7796a0f0012dc2974a2e2d8d2a` |
| 87f4fd2f_6 / 1 | 0.627 | 1.817 | 2.444 | ok | `f63ede2c6e669137f1b026d30d6a0b25` |
| 87f4fd2f_6 / 2 | 0.656 | 2.059 | 2.716 | ok | `f63ede2c6e669137f1b026d30d6a0b25` |
| 87f4fd2f_6 / 3 | 0.628 | 1.746 | 2.374 | ok | `f63ede2c6e669137f1b026d30d6a0b25` |
| 87f4fd2f_6 / 4 | 0.651 | 1.933 | 2.584 | ok | `f63ede2c6e669137f1b026d30d6a0b25` |
| 87f4fd2f_6 / 5 | 0.653 | 2.321 | 2.974 | ok | `f63ede2c6e669137f1b026d30d6a0b25` |
| 87f4fd2f_6 / 6 | 0.702 | 1.817 | 2.520 | ok | `f63ede2c6e669137f1b026d30d6a0b25` |


## 数据库观察：独立的旧版本补充样本

以同版本 `TraceIdRatioBasedSampler(0.1)` 对日志中的六个实际 daemon trace ID 重算，结果均为 DROP；本批未取得 DB 统计。这个检查没有改变生产采样配置。另有上一批一个前后版本锁定成功的 Claude run，hash `ea19bb4aa96bb6dc`，应用 `2960d783`、同一 worker `ca9057a1`。该样本不能混入本批 `c0c98baa` 的分组统计。

[真实 PostHog trace](https://us.posthog.com/project/670821/tracing?trace=dc39ac07f679edbeb6d92b3984900f88)共两页、2,524 spans、无重复 span ID。按实际 pg instrumentation 观察到 2,331 条数据库语句：SELECT 1,721、INSERT 121、UPDATE 34，其余为事务/SET 等指令。返回结果 JSON 大小近似合计 420,347 bytes，**不是 PostgreSQL wire 流量，也不是写入 bytes**。[数字归档](2026-11-06-cloud-startup-production-baseline-db.json)保留按 native span ID 关联的每次请求统计。

五次已记录 provider 代理调用分别包含 53、53、53、58、53 条 pg 语句；九次 context 调用为 53–56 条。按最近服务端 HTTP 祖先分组：tool-approval 991 条、subscription 753 条、events 258 条、complete 212 条、policy-snapshot 66 条、PATCH run 51 条。这里的计数来自既有 traces，未向生产数据库新增计数查询或轮询。

## 下一阶段的验收

基线已留下逐次 provider 代理准备成本，表中的 provider_headers 含上游 TTFB，不能称纯 Mikka 开销。优化后将通过完整实际 HTTP 发送收据证明运行期没有额外鉴权或 provider proxy；自然到期后台续租、共享 heartbeat/run-control、遥测分别列出。官方 CLI 的 provider/tool 数字遥测标记 best_effort、flush=not_confirmed，未收到事件不会记成零调用。

仍须在严格 dispatch 入口口径下完成派生模板与 #1508 pool 的实际生产比较，官方文件守恒和两订阅候选门槛也必须通过；当前不关闭 #1505。
