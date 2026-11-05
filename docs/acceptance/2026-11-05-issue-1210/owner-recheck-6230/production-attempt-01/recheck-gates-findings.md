# ALEX43 单次 Owner Retry review 阻塞核查

## 结论

已取得一个可复现的明确准入阻断条件：原冻结官方 Claude Code `claude-haiku-5-5` 订阅的全局 weekly 窗口已用满。官方快照 `observedAt=2026-11-05T23:14:06.758Z`，在 root 报告的单次正常 UI 点击 `2026-11-05T23:14:03.905Z` 之后 2.853 秒；该窗口 `used=1`，重置时间 `2026-11-06T00:00:00.000Z`。

这份快照按部署版本 `82789ddf380841a4f3ea637d940005bbbd2cecdd` 的实际纯函数，在 root 使用的本次 POST 数据库日志时刻返回 `exhausted`。当前快照变旧后、或仅让时钟越过 reset 而不取得新官方快照，都返回 `checking`，不是 available。独立来源审查代理 `/root/release_gate_1449` 已直接核对原始响应和 root 的本地纯回放结果。

**没有捕获失败 POST 的响应 body 或实际抛出的 closed detail，因此本结论是与本次刷新时间一致、按源码可复现的额度准入阻断，不能写成“已从服务器日志取得 quota 错误码”。** 当前健康投影无优先拒绝行；它是当前观测，不能冒充完整历史状态回放。

## 单击后的实际副作用边界

`production-click01-observation-response.json` 的数据库采样时间为 `2026-11-05T23:22:03.184Z`–`23:22:03.192Z`：真实 owner_candidate_recheck 回执 0、position > 4 的 attempt 0、active run / 有效 lease 0、接受记录 0。task 仍 verify/waiting revision 13，旧问题 waiting_user revision 2、原 expiry 和八个 NULL 消耗字段均保留。candidate / epoch / d05417… 交付 HEAD 与父机 sleeping 状态均未变。

与 23:04 原始点击前响应共有 48 个字段逐项相等。没有新的 review/verify run、SID、VM、工具 IO 或报告可供验收。本次没有把旧 verify 改成成功，没有回答旧过期问题，也没有最终 Owner 接受。无可见已提交事件不代表 HTTP 请求没有执行或没有发生事务回滚。

## 最小只读投影结果

| 批次 / 数据库时间（UTC） | 源码对应范围 | 实际结果 |
|---|---|---|
| 01 / 23:27:51.977 | nativeRunBinding、SubscriptionRepository、model-order | 两个旧检查的绑定 consumer / route / workspace / connection / epoch / model 均一致。原 agent 仍属于 Owner；连接 connected、未 paused / removed、自有非共享。当前目录包含 frozen Haiku；profile 与 API-key 键均 absent。 |
| 02 / 23:29:24.240 | automatic-dispatch、bot-runtime-records | producer、旧 review/verify 和当前 Bot runtime agent 都是 `c5dc010b-c4b4-4504-945f-9791f9d30300`；设备、工作区、ownership、desktop 和 runtime repo / candidate repository 一致；父机 sleeping、ready、device enabled。 |
| 03 / 23:31:10.038 | execution-model-options、subscription quota public protocol | exactOrderCandidateExists=true；quota 公共结构有效。官方快照来自 23:14:06.758，five_hour used=0.04；全局 weekly used=1；另有仅 model=fable 的 weekly used=0。 |
| 04 / 23:35:34.214 | model-provider-health 目标 source / entry 的优先健康观察 | selected permanent/transient 行均为 0。仅返回状态、ID、schema 标志与时间；没有输出 provider message、任意 raw report 或 code 值。 |

四组 SQL 均先由来源审查代理按部署源码确认字段、路径和判定，再运行 `READ ONLY`、5 秒 statement_timeout 的事务。原始 SQL、请求、响应、采集时间分别保存在各 `recheck-gates-0N-*` 文件。没有读取加密凭据值，没有执行凭据 refresh、模型调用、浏览器动作或生产写。

## 为何 fable 剩余额度不能放行本次 Haiku

部署源码 `packages/protocol/src/subscription.ts` 的 `subscriptionQuotaScope` 将无 model 的全局 weekly 窗口用于原 Haiku；model=fable 的窗口对 Haiku 标为 irrelevant。`subscriptionQuotaState` 在官方快照新鲜的 60 秒内发现适用窗口 used >= 1、且尚未越过其 reset，就返回 exhausted。

`lib/model-order.ts` 在无更优先健康拒绝时，把 exhausted 映射为 credential `{usable:false, reason:'quota'}`；`lib/factory/agent-profile.ts` 的 `assertFrozenModelTarget` 映射为 `AgentProfileError('agentProfileModelUnavailable', detail:'quota')`，外层 Owner recheck 捕获后包装为 `FactoryError('agentProfileUnavailable')`。这是源码确定的错误链，不是本次失败 HTTP 响应的实测错误链。

`root-quota-replay.json` 直接使用 03 原件进行本地纯回放，两个阶段结果一致：实际 POST DB 日志时刻 exhausted；23:31 读取时刻 checking；越过 00:00 但无 fresh provider read 仍 checking。没有为了验证这个结论调用 provider 或启动任何新模型。

## 后续范围与仍未完成的验收

按 root 指示，04 是最后一批诊断读取；不继续 membership 或全面查询。Membership / 其他后续事务门槛没有在本轮独立投影中观察，不能声称它们已通过。当前证据已足以明确原订阅额度不满足新检查准入；没有证据支持绕过门槛、切换 API key、改模型或刷新/回答旧问题。

ALEX43 的原六项合同与最终 Owner 接受保持未完成。若后续按正常产品流程在新的官方快照证明原订阅可用后再试，仍须对真实 fresh review/verify 及时采样 SID/VM，逐项核查 inspect_artifact 的实际输入/输出、冻结宿主命令和问答生命周期，然后才可能进入最终正常 Owner 接受。本轮并未代替这些验收。
