# #1156：网关握手与空闲设备可靠性

对应 [issue #1156](https://github.com/alexj11324/Mikka/issues/1156) 和
[PR #1173](https://github.com/alexj11324/Mikka/pull/1173)。

## 状态与环境

本文件将本地证据、代码推导和生产观察分开。生产一小时验收尚未完成，不能据此关闭 issue。

- 最初基线：`eea7149d40ec70a65e7f6c81268d08394990e4ca`；已整合主干 `5710b3492cd87f9919887792de7e3357a2a343a7`（#1172）。该云端派发变更没有新增本地事务宿主或空闲周期请求。
- 修复分支：`fix/1156-device-gateway-reliability`；最终测试版本以 PR 的不可变 head SHA 和关联 CI 为准。
- 本地运行：云 Linux，Node `24.22.1`；真实 Miniflare/workerd 与 Node 内置 WebSocket，通过回环 HTTP/TCP 通信。
- 数据库验收：现有 CI 的临时 PostgreSQL 17，回环 `mikka_e2e`，`REQUIRE_DB=1`；不使用生产数据库。
- 生产目标：既有 Mikka Vercel 项目 `prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`、团队 `team_C7lwxVVvnUicFli6112mvxpv`，既有 `mikka-device-gateway` Worker。
- 没有修改 Neon suspend 设置、撤销共享凭据、删除部署或创建云资源。

## 已确认的失败路径

| 问题 | 发生可能性 × 影响 | 证据与处理 |
| --- | --- | --- |
| DO 的 101 没有选回票据子协议 | 10 × 8 = 80 | 同一 Node 24/workerd 握手测试修复前在 Undici `failHandshake` 失败，修复后 `open` 且 `socket.protocol` 等于票据。Worker 验证后只向 DO 传入选中的一个协议。 |
| 停止 HTTP 心跳后按 60 秒数据库时间判离线 | 10 × 7 = 70 | 旧派发函数使新增回归失败。新代码在旧心跳过期时按需查询网关，使用最近自动 pong/建连时间的 90 秒窗口；旧 daemon 保留原心跳规则。 |
| 推送未登记响应后的执行生命周期 | 5 × 8 = 40 | 原实现丢弃 fetch Promise。新实现使用 Next `after()`，其他 Vercel 上下文使用 `waitUntil()`；暂时性错误最多三次尝试。 |
| 卸载信号早于数据库提交 | 6 × 7 = 42 | 卸载在同一事务禁用设备并写命令；信号改在 COMMIT 后登记。隔离 Postgres 测试用另一连接读取已提交状态。 |
| Factory/Skill 外层事务提交前就发出工作信号 | 4 × 7 = 28 | 嵌套 after 或直接 waitUntil 可以立即开始，设备可能在事务提交前拉到空队列。内层 admission 不再通知；七处实际事务宿主在 COMMIT 后通知，已有回调继续由外层提交后调用。真实 Postgres 回归检查回滚、完整提交可见性与重放。 |
| 断线后立即重新申请票据并连接 | 8 × 6 = 48 | 原 `holdGateway()` 结束后可直接进入下一轮。已实现约 4–60 秒带抖动的指数冷却，期间长轮询继续；连接稳定 60 秒后才重置失败计数。 |
| 空闲唤醒后没有重新安排周期续租 | 10 × 9 = 90 | 原空闲分支 `schedule(null)` 停表，onWork 只做一次 sync。已恢复唤醒后的周期续租，并在任务完成后再次停掉空闲周期请求。 |
| 已收到卸载命令后再次请求 commands 提前清凭据 | 7 × 7 = 49 | 实际 daemon 命令循环与真实 setImmediate 顺序回归复现；卸载且无活动任务时结束命令循环，先提交 receipt，再由正常卸载路径清凭据。 |
| 无关闭码的客户端断开导致关闭回调异常 | 7 × 4 = 28 | workerd 真实回调报告 1005，但不能发送该保留码。对 1005/1006 使用无参数 close；真实 Node 关闭从超时恢复为 clean close。 |

网关的在线状态只用于可用性判断；设备所有者、启用状态、移除状态、令牌有效性和任务读取鉴权继续由原服务端路径决定。状态接口只接受服务端推送密钥，设备票据不能查询状态。

## 本地验证

统一入口：

```sh
pnpm test:device-gateway
```

其中真实运行时部分可单独执行：

```sh
node --test cloudflare/device-gateway/test/runtime.test.mjs
```

已实跑的整合结果：6 项服务端 presence/推送测试、8 项路由/票据测试、6 项真实 workerd 测试全部通过，无跳过；daemon 相关 34 项、发布顺序 10 项也通过。类型检查和相关 Factory 回归已通过；最终整合版本还须绑定其 CI 结果。

真实运行时用例验证：精确子协议协商、多个候选协议的选择、错误设备票据拒绝、服务端 status 鉴权、自动 pong 确实抵达、自动应答时间推进、真实 work 推送、正常断开后离线。消息数为零不能替代这些证据。

数据库用例 `lib/device-presence.db.test.ts` 已接入既有 `test:device-revocation-db`，覆盖一小时前的数据库心跳仍可通过网关在线派发、拒绝其他所有者、不写伪心跳，以及卸载提交后可见性和凭据回执宽限。首轮提交 `acef2245e0e8bfea970d3ff2884abbc106567aab` 的 [Postgres CI job 126261383708](https://github.com/alexj11324/Mikka/actions/runs/41734841312/job/126261383708) 已实际通过该用例，无跳过。首轮其他两处失败来自原有测试夹具：重试设备未给 lastSeenAt、native 测试表未给 removedAt；夹具已补齐，未放松实际设备判定。

整合提交 `e0b4c52977b79455f3033eec7de72b5dc5b72b14` 的 [完整 CI 41736452294](https://github.com/alexj11324/Mikka/actions/runs/41736452294) 已通过源码、核心与集成单元、完整 daemon 和全部四组真实 PostgreSQL 检查。随后追加的 Factory 提交顺序修复和 #1172 主干整合须以更新后的 PR head CI 为准，不能借用该绿色结果。新增回归在 `tests/factory-admission.db.test.ts`，由既有 `test:factory-routing-db` 执行：HTTP 接收端以独立数据库连接检查 run、publication、Factory binding 和 receipt 已同时提交；外层回滚及严格重放不得产生额外信号。

daemon 的受控时钟测试模拟一小时：真实 polling/gateway/drain/schedule 逻辑，WebSocket 和 sync 的外部边界用 mock；启动后 gateway、commands 和 sync 均没有再调用，发送 120 次 ping，重连 0 次。这验证调度触发逻辑，不是完整 Daemon.start 的实际 HTTP 计数，更不是生产一小时数据。

独立的真实等待探针 `node --test cloudflare/device-gateway/test/presence-expiry.mjs` 验证：socket 仍为 OPEN，但 95 秒不发 ping 后 status 离线；再收到真实自动 pong 后时间推进并恢复在线。它与快速 CI 分开，不会把每次单元检查拖长 95 秒。

## 每分钟请求预算：代码推导，尚非生产实测

下面的零值指：**连接和初次补拉已经完成，设备无任务、无待上传结果，未发生断网、版本发布或用户主动查询设备状态**。单台设备的正常空闲稳态：

| 类别 | 次/分钟/设备 | 为什么 |
| --- | ---: | --- |
| Worker 新 HTTP / WebSocket upgrade | 0 | 已建立的 WebSocket 持续使用，不定时重新握手。 |
| DO fetch / RPC 调用 | 0 | 无轮询、无 alarm、无人查询状态或下发工作。 |
| DO 收到应用层 `ping` | 2 | 每 30 秒检查连接活性。 |
| DO 发出应用层 `pong` | 2 | 由运行时自动应答，不调用 JS 消息处理器。 |
| DO 显式持久化读写 | 0 | 最近自动应答时间由运行时维护，不调用 storage。 |
| Vercel `/v1/devices/:id/gateway` | 0 | 仅建连/重连申请一次票据。 |
| Vercel `/v1/devices/:id/commands` | 0 | 已连接时只在初次建连或收到 work 后补拉。 |
| Vercel heartbeat / repos / pending-runs | 0 | 空闲且无待提交工作时停掉周期 sync。 |
| 设备空闲链路触发的 Neon 查询/写入 | 0 | ping/pong 和在线时间不经过 Vercel/Neon。 |

六台设备对应每分钟 12 个入站 ping、12 个出站 pong；上述新 HTTP、RPC 与设备空闲数据库查询目标仍为 0。不能把这张表解释成整套应用的数据库查询为零：网页读取、cron 和实际业务有独立来源。

以下事件单独计数，不能混入稳态后说请求异常，也不能拿它们掩盖持续重连：

| 事件 | 正常新增请求 | 必要性与限制 |
| --- | --- | --- |
| 首次连接/一次重连 | 1 次 Vercel gateway，1 次 Worker upgrade，1 次 DO fetch，再补拉 commands 和完整 sync | 连接阶段至少 5 次 Vercel 设备请求：票据、commands、heartbeat、repos、queued runs；进程首次启动的注册和初始同步另外计数。票据路由经过鉴权和设备凭据 fence，**不能写成固定只有一条 SQL**。 |
| 用户或业务需要判断一台心跳过期设备是否在线 | 1 次 Worker status + 1 次 DO status RPC | 读取当前连接的最近自动应答。不会为该状态写 Neon；调用者原有授权查询另计。同一列表中的重复设备去重。 |
| 一次新工作信号 | 正常 1 次 Worker push + 1 次 DO notify RPC + 1 个出站 work | 信号无正文；daemon 再通过原鉴权路由取工作。暂时性失败最多 3 次 push 尝试。 |
| Factory/Skill 本地任务由外层事务入队 | 提交后最多增加 1 次 Neon SELECT，再通知对应设备 | 只查已提交、属于该用户且未停止的本地排队任务；已有设备 ID 的提交后回调直接通知。未配置网关时不查库，空闲时无新增查询。 |
| 实际执行任务 | commands、claim、ACK、心跳/续租、结果上传等按工作发生 | 有活动任务必须继续续租；空闲优化不能停掉活跃任务的心跳。 |
| 网关不可用/旧 daemon | 默认 25 秒长轮询约 2.4 次/分钟，另有普通周期 sync | 是兜底而非正常稳态。当前等待内检查间隔 2 秒，约 30 次读取/分钟，还需加入入口鉴权等语句。不能把兜底流量说成零。 |

### 兜底请求及鉴权开销

默认配置、普通本地设备、空队列时，网关不可用的每分钟预算如下。网络耗时会让实际速率稍低；这是代码推导，不能代替指标差值。

| Vercel 路由 | 次/分钟/设备 | 原因 |
| --- | ---: | --- |
| `commands?wait=25` | 约 2.4 | 25 秒长轮询兜底；每轮最多约 14 次廉价工作检查，约 30–33.6 次检查/分钟。 |
| `heartbeat` | 约 4 | 默认 15 秒一次 sync，维持旧在线状态、处理回执及续租。 |
| `repos` | 约 4 | 每次 sync 同步设备仓库。 |
| `runs?state=queued` | 约 4 | 每次 sync 查询待执行任务。 |
| `gateway` | 仅重试冷却到期后的下一次循环 | 4–60 秒带抖动的退避，还受长轮询轮次约束；不是每轮无条件申请，也不是固定每分钟一次。服务端明确未配置时，本进程停止继续申请。 |

一次成功的票据请求不是“一次数据库查询”。对于普通未绑定云机、未移除的本地 token，正常路径至少有 1 次 token SELECT、1 次所有权 SELECT，以及凭据 fence 的 5 条 SQL（BEGIN、两条 SET、token FOR SHARE、COMMIT），合计 **7 条 SQL、5 次 query 调用/数据库往返**。token 的 `lastUsedAt` 超过一分钟时还会更新一次；特殊凭据范围校验另计。三条 BEGIN/SET 共用一次 query 调用，因此 SQL 语句数、驱动往返数和 HTTP 请求数不能混用。

每次兜底 heartbeat 还可能触发默认开启的 Factory `deviceOnline` 响应后检查；即使没有排队任务，也有其自身的事务与查询。因此不能只数同步 heartbeat 的前台 SQL，或把 2 秒廉价工作检查的数量当成全部 Neon 开销。上述兜底开销在正常网关空闲稳态中不发生。

以默认 unit fence、普通本地 token、无活动任务/回执/能力变化为例，设 `R` 为需要读取设置的有效 remote 仓库数：

| 路由或范围 | SQL 语句预算 | query 调用预算 |
| --- | ---: | ---: |
| 每次 gateway | 7 | 5 |
| 每次 repos | 8 + R | 6 + R |
| 每次 queued runs | 8 | 6 |
| 每次空 commands（25 秒，14 次检查） | 21 | 19 |
| 每次 heartbeat，仅前台 | 12 | 10 |
| 每次 heartbeat，含默认 Factory 检查及一个后台 fence | 约 21 | 约 17 |
| 4 次完整 sync + 2.4 次空 commands，每分钟、Factory 默认开启 | 约 198.4 + 4R | 约 161.6 + 4R |

最后一行是低延迟名义频率下的量级示例，另加票据失败重试、token 时间更新及其他条件工作；不是实测值或全局上限。每个额外 fence burst 为 5 条 SQL / 3 次 query。`deviceMayHaveWork` 的等待内只读检查把凭据校验合并在同一条 SQL 中，不为每个检查重复加一次 fence。`lastUsedAt` 更新也不具备跨并发请求的“一分钟最多一次”保证。

核算入口：`packages/daemon/src/main.ts` 与 `server-link-http.ts`，`app/v1/devices/[deviceId]/{gateway,commands,heartbeat,repos,runs}/route.ts`，`lib/device-route.ts`、`lib/device-link.ts`、`lib/db/device-scope.ts`、`lib/device-management.ts` 和 `lib/factory/dispatch-recovery.ts`。在线查询按需发生，目前没有跨请求 TTL 缓存，频繁刷新页面会产生额外 Worker/DO 状态请求。

Cloudflare 将消息量、调用量和账单单位分别记录。官方定价说明入站 WebSocket 消息按 20:1 折算计算请求单位，出站消息不计此请求费；自动应答不增加 duration。这里的字符串 `ping` 是应用层消息，并非 WebSocket 协议控制帧。因此“JS 没被唤醒”不能推导出所有计量都为零，实际账单维度仍需核验。

## 生产一小时验收记录要求

部署前先让 Vercel 的新在线判断生效，再更新既有 Worker。否则握手先恢复时，旧 Vercel 仍可能把正常空闲设备判离线。daemon 的修复版本也必须安装/运行，不能用服务端上线代替设备升级证据。

固定记录以下版本和边界后，连续观察至少 60 分钟：

1. Vercel deployment ID、源码 SHA、Worker version ID、各设备 daemon 版本、UTC 起止时间、设备数量；跨部署的窗口重新分段。
2. 每台设备的 open/close/error 时间、重连次数、实际 pong 收到数量。要求每台设备一小时重连不超过 1 次；首次建连单列。
3. Vercel 真正的请求/调用指标按 route 聚合，列出 gateway、commands、heartbeat、repos、runs 等。空 runtime logs 只代表没有日志，不能证明无请求。
4. Cloudflare Worker 与 DO 指标分开，记录 WebSocket 应用消息、fetch/RPC、duration、存储；WebSocket 连接调用可能直到关闭才进入调用指标，不能把未结束的连接当成零连接。
5. Neon 使用同一窗口的语句计数差值确认设备轮询消失。不要为观察休眠每隔几秒发 SQL 把 compute 唤醒。原有 cron/网页活动及其他查询另记。
6. 一次空闲后派发，确认任务开始、超过原租约窗口后继续续租、命令 ACK、任务结束后重新进入零 HTTP 稳态。记录派发 p50；没有基线样本时明确无法比较。
7. 一次受控网关不可用后仍能通过长轮询接收工作，恢复后退避重连并补拉。故障注入窗口不得混入正常稳态计数。

目前尚无这一整小时的生产证据，不能宣称连接稳定性、零空闲请求或 Neon 实际休眠已验收。

本轮保留生产 `DEVICE_GATEWAY_URL`。删除环境变量需要重新发布才影响现有部署；旧 daemon 收到“未配置”后会在本进程缓存 `gatewayUnavailable`，恢复环境变量后仍需重启设备进程才能重新接入网关。修复按“Vercel 在线判断 → Worker → daemon 升级”发布，避免在没有配套恢复步骤时临时切换。生产修改与一小时观察须在 PR 审阅合并后完成；本轮遵守 issue 的只推分支、开 PR 边界。

## 重复构建：已找到有效的业务变更样本

`#1164`、`#1167` 都修改了 daemon，因此不能用它们的第二次部署判定业务提交去重失败。

`#1171` 的源码 SHA 为 `eea7149d40ec70a65e7f6c81268d08394990e4ca`；与前一个 `#1167` 的 worker hash 同为 `9d9799cd6edac2d8920b4b47cb6bef73736d5742`。
[GitHub Actions run 41732647577](https://github.com/alexj11324/Mikka/actions/runs/41732647577) 已完成：check 成功，validate/publish 跳过。按该 SHA 筛选，Vercel 只有一个 READY 生产部署 `dpl_5D8aFZuvrZnmRZr4uu1Z78Wp8Nc9`。这提供了运行时未变化的业务合并只有一次生产部署的实证。

现有发布逻辑保留：模板值未变化不写环境变量、不 redeploy；不越过更新的 READY 部署重发旧源码。当前 Factory 服务仅注册 Skill 激活发布适配器，Vercel 发布适配器没有生产调用方，未发现它触发 Mikka 二次部署的证据。

## 锁等待调查边界

当前设备长轮询的等待不跨持锁事务。2026-11-03 22:59:41 UTC 对既有生产分支、应用数据库 `orvilo_mvp` 的只读诊断确认：统计从 10:57:56 UTC 起，归一化 `SELECT pg_advisory_lock(hashtextextended($1,$2))` 已调用 38 次，平均执行 16,627.334 ms，最长 103,667.899 ms。事务级 advisory lock 的另一个指纹平均 10.340 ms；两者不能混为一谈。此时 `deviceMayHaveWork` 累计 112,965 次，也说明部署修复前仍在持续轮询；该累计数不代表一分钟的速率。

当前仓库唯一相符的会话级锁调用在 `lib/linear-sync/publication.ts:withPublicationWriter`，由 `issue-sync.ts` 和 `archive.ts` 使用；在 dedicated connection 获取锁，持锁期间执行远端 Linear 操作，最后关闭连接释放。这条路径可以解释同一 publication 的等待积累。现场锁快照只看到已获取的设备凭据锁（约 87 ms），没有抓到该会话级锁的实时阻塞链，因此这是历史指纹与当前调用路径的对应，不是对具体阻塞会话的复原。本次不移除另一条发布链路保证并发正确性的锁，也不宣称修复了 16 秒等待。

## 参考

- [Cloudflare DurableObjectState 与自动应答时间](https://developers.cloudflare.com/durable-objects/api/state/)
- [Cloudflare Durable Objects 定价与消息折算](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare WebSocket 指标记账时点](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [Next after 的响应后生命周期](https://nextjs.org/docs/app/api-reference/functions/after)
