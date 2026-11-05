# A 窄候选独立评审

**最终结论：本次 8 文件、默认未启用的实验候选未发现残余源码阻断，可以作为代码与证据检查点保留。生产启用、性能收益与 A 完成条件仍未满足。**

审阅人：`egress_1211`。固定原始源码：`a410b292cc53cfef43992a91d7696023e3481567`。本次只读共享源码、原始日志和固定 GitHub 源码；未修改候选、未运行模型、未调用生产、未新建环境。

## 范围与结论

本次候选是显式注入的 TS run authority 实验。生产调用者不传入 source 时，原一秒 background check、原实时操作检查和原 HTTP 失败语义仍在。没有生产 source 连接、迁移、发布或启用证据。

已完整审阅四个产品模块：

- `packages/daemon/src/agents/run-authority.ts`
- `packages/daemon/src/agents/tool-approval.ts`
- `packages/daemon/src/server-link-http.ts`
- `lib/run-authority/source.ts`

另外亲读 consumer 测试、完整 split-DB 测试、实际 HTTP child 夹具、test-only trigger helper、固定 a410 的 ClaudeAdapter 与已有 lease-loss liveness 用例。

本次结论只适用于保留默认不启用的有界候选；不支持删除生产 timer、宣称 A 完成、宣称 egress 下降或通过三路径生产验收。

最终候选工作树记录为 `202fe0baf19f3a45f110b16e705085cd364d2726`，基线仍是 a410，尚无 commit/PR。已独立重算 `candidate-manifest.json` 中全部 8 个文件的 Git blob、bytes 和 SHA-256，均一致；同时重算 `final-packet-manifest.json` 中 71 个文件的 bytes/SHA-256，0 个不符。这里没有把对 8 个 blob 的核对写成对完整基线 tree 的独立重新构造。

## 已识别并要求修正的证明边界

1. **方法参数兼容。** 实现代理的类型门禁发现原第四参数是 `worktree?: string`。已亲读修订源码：保留第四参数 `_worktree?: string`，source 只在第五参数注入。原接口与旧调用者仍保持原形；已亲读对应正式 daemon typecheck exit 0。
2. **退出时间断言。** 原 `until()` 每轮先检查 condition，最终又检查一次；晚于一秒的下一轮退出可能仍产生 `deadlineMet=true`。历史 519/578 毫秒的原始观测没有因此失效，但该断言不足以保证未来回归的严格界限。已要求直接按记录的 `exitedAt` 时间差作最终断言，并在 Stop 前明确确认 child 尚未退出。
3. **真实退出原因。** 已要求断言 `gate.revoked` 与 fake CLI 的 `143` SIGTERM marker，而非只打印它们。固定 a410 ClaudeAdapter 的 revoke 回调确实向实际 child 发送 SIGTERM；fake handler 同步写 marker 后调用 `process.exit(143)`。此场景不证明任意拒绝 SIGTERM 的程序、其后代进程或真实付费 CLI 均在一秒内退出。
4. **同一夹具的 RED/GREEN。** `red-cli/red-4.log` 是早期有效 RED；前三次是保留的 setup/夹具失败。最终新双场景严格断言版必须单独绑定夹具 SHA 与旧/新产品版本，不能只复用早期 RED 名称。

以上第 2–4 项已在最终夹具修正并实跑。HTTP fixture SHA-256 为 `363a8fa8015efd467c601b8b0bc57af0e1ce3f19b837714d72a830b0ef28c645`；最终源码明确同时验证从 Stop 调用之前开始的保守时间差不超过一秒。不是仅按等待辅助函数的布尔返回认定通过。

## 控制期限与竞争边界

| 检查项 | 亲读的行为 | 可支持的结论 |
| --- | --- | --- |
| challenge 发出时间 | `performance.now()` 记录 `sentAt`；首次 pending 也立即设置 `sentAt + 750ms` 期限 | 未收到首个回复也会失效；不是收到回复后重新获得完整 TTL |
| 迟到与重放 | 回复必须在旧 deadline 和本次 `sentAt + 750ms` 前，run/nonce 精确匹配且 live 为 true；无效 duration 拒绝 | 旧回复、错 run、错 nonce、拒绝和超时不能续授权 |
| 不可复活 | `fail()` 先 close/abort，再通知 gate；后续回复与 invalidate 都检查 abort | 同一 gate 失效后不会因重连或迟到成功恢复 |
| renewal 在途 | pending renewal 不延长旧 deadline；独立 expiry timer 仍运行 | 源 HTTP 或 PG barrier 停滞不会以“请求尚在进行”保留旧授权 |
| 工作提示竞争 | in-flight challenge 期间 invalidate 保留 dirty，完成后再发新 challenge | 提示不替代权限结果；并发提示不会仅复用旧请求便结束 |
| 真实操作 | 有 source 时 `checkLive()` 仍等待 source ready/current，并执行原 `host.isLive()`；返回前再核 current | 候选只替换被显式注入 run 的背景 host check，不把实际操作变成长期缓存授权 |
| 双库 bracket | App/Workspace 各读 before version，执行完整 reader，再各读 after；两边 source/revision 都必须一致，最多三次重读 | 版本覆盖成立时，可发现 reader 期间已提交的 Stop、membership、FK cascade 与 ABA |
| 自然到期 | source 接口要求 complete reader 返回保守 remaining duration；消费端再截断至 750ms；50ms 到期例不依赖通知 | 消费端期限行为有测试；生产全部 expiry 的完整 reader 尚未建立 |

双库测试使用不同实际 PG 数据库，真正调用既有 `AgentToolApprovalStore` / policy / membership reader。HTTP child 场景的实际 route 仍使用 combined DB；第二物理 DB 在该场景只参与 version vector。两组证据必须分开，不能合称一条“完整 split-DB child 端到端”证明。

## 已独立核对的历史与中间证据

`evidence-intermediate/manifest.json` 的 46 个文件均已按 bytes 与 SHA-256 重新计算，0 个不符。以下结果来自亲读原始 stdout/rc，而非复跑：

| 原始日志 | 实际结果 | 限度 |
| --- | --- | --- |
| `mikka-authority-full-http-final.log` | 原 store 12/12；HTTP 4/4；child exit 519.579107ms，marker 143 | 补强严格时间断言之前的历史夹具 |
| `mikka-authority-version-db-final.log` | 7/7；旧位置 PG barrier child 578.204431ms，锁等待观测为 true | child 场景随后移至 HTTP `.mts`；不挪用为最终布局结果 |
| `mikka-authority-version-db-final-2.log` | split-DB 6/6，0 skip | 真实 complete reader、Stop、membership、rollback、FK cascade、ABA |
| `mikka-authority-consumer-review-final.log` | 28/28，含 13 新期限用例与选择的既有 gate/liveness 测试 | 不是全 daemon/native/API 覆盖 |
| `mikka-authority-app-types-review-final.log` | App 正式 typecheck exit 0 | 对应候选源码 |
| `mikka-authority-daemon-official-types-final.log` | 仓库正式 `tsgo --noEmit -p tsconfig.json` exit 0 | 之前额外 tsrs 失败原件仍保留 |
| `mikka-authority-idle-go-1.log` | 原 Go 三路 context cancellation 997.248/998.250/997.758ms，均无输出 | 原有轮询路径的静默 provider 基线；没有使用新 TS source，不是优化结果 |

## 最终严格夹具与文件绑定

已亲读 `evidence/mikka-authority-strict-final-results.json`、最终旧产品 RED 和新产品完整 GREEN 原始日志。两次使用同一最终 HTTP fixture；RED 仅把既有 `tool-approval.ts` / `server-link-http.ts` 恢复为 a410，之后逐字恢复候选。记录为 old product exit 1、candidate exit 0、fixture lint exit 0、productRestored=true。

| 最终场景 | 原始观测 | 严格门禁 |
| --- | --- | --- |
| 旧产品，HTTP 交付阻断 | Stop 返回后 1002.706149ms，gate/child 均未结束，marker 不存在；challenge 数为 0 | 预期 cancellation 断言 FAIL，1/1 失败；不是 setup 错误 |
| 候选，相同 HTTP 故障 | gate 518.711579ms，child 525.116946ms，Stop 调用耗时 2.501888ms | 两种起点的一秒断言、gate、143 marker、仅 exit 均 PASS |
| 候选，真实 PG barrier 锁等待 | `pg_stat_activity` 的 Lock 等待为 true；gate 652.676694ms，child 656.030740ms，Stop 调用耗时 2.403755ms | 同样全部 PASS |

最终 GREEN 原始日志同时包含原 store **12/12** 与完整 HTTP **5/5**，均 0 skip。split PG **6/6** 与 consumer **28/28** 的最终文件未再改变；正式 App/daemon 类型检查仍为 exit 0。lint 的精确范围是四个产品文件和最终 HTTP fixture，各原始日志明确 4 files/1 file；没有把它扩大为全仓 lint。

最终候选 Git blob：

| 文件 | Git blob |
| --- | --- |
| `lib/run-authority/source.ts` | `9137ca135fb32d02656b7fdc502c0b2d88c56151` |
| `packages/daemon/src/agents/run-authority.ts` | `43e8f64eb45d34789804534e360f33a6268108b2` |
| `packages/daemon/src/agents/tool-approval.ts` | `3012f0a08ce1885a75df441fcce49cf07aae4150` |
| `packages/daemon/src/server-link-http.ts` | `0f6ff83b96596dd06176fe7e5f97c629d39b5ba6` |
| `lib/agent-tool-approval/http.db.test.mts` | `177601f27b2d2195497d2a5b7f24203100d25868` |
| `lib/run-authority/source.db.test.ts` | `349ec34ac674a45199c0085620b581d27b6c1f47` |
| `packages/daemon/test/run-authority.test.ts` | `209e4b41e112fc6bb6ec89eac228a314f4b98210` |
| `tests/helpers/run-authority-version-fixture.ts` | `01ebaebf1fed8f0ae5f3f236743dcaef6e7ada15` |

## 未证明、不能上线时省略的事项

- `run_authority_version` 只由测试 helper 建立；遍历全部 fixture public 表的 trigger 不是生产依赖 manifest。运行时身份、两库实际连接、写入覆盖、FK/动态写入和自然期限均需另行证明。
- 当前每个 challenge 都执行完整 reader；无 settled-success cache。成功一次明确是一次完整读，加 App 两次/Workspace 两次 version 查询；200ms 调度不能称作零查询或流量下降。
- 新 source 的 grant 不携带既有 `device_lost` 原因，pause/resume、完整 token/policy/control expiry、生产失联和重新取得权限语义尚未完成接线。旧默认路径的原因与 pause 测试继续成立，不等于新 source 已覆盖。
- 生产 source 的事务隔离、同源连接与版本机制尚未固定，不能从测试 Pool、已恢复的 PG 数据或 WS/pong 推导生产权限最新。
- TS child 场景不能替代 Go native/CPA、API runner、真实订阅模型和生产三路径的验证。Go 新日志仅是旧路径基线。
- 尚无生产 deployment/version、性能完整窗口、真实 paid CLI 或生产 egress 下降证据。

## 证据保存与清理

最终发布应保存所有旧失败与新成功原件、精确 source/test/tree 哈希，并只清理本任务自己记录的进程与隔离数据库。不得停止共享 sandbox 或他人服务。

已亲读 `owned-process-check.json`：`2026-11-05T00:30:28.934792+00:00` 时本工作目录剩余进程为 0，共享 PostgreSQL 未停止。当前包没有提供隔离数据库已 absent 的回执，因此本评审不声称数据库已清理；由资源负责人在其他任务结束后按本任务确切清单处理。

本次另发现共享 `candidate/` 目录留有早期第九个 Go baseline 拷贝，但它不在最终 8 文件 filemap/tree 或 71 文件归档中。`historical-layout/authority_idle_test.unformatted.go` 与 `go-baseline/` 原件已保留，评审通知实现代理移出 manifest 外的旧 candidate 副本；保存代码必须使用已核的 8 文件清单，不能把共享目录整体复制。REVIEW 的 lint 范围已修正为产品四文件加最终 HTTP fixture。这些整理不改变 71 文件原始归档或产品。

Refs #1212.

## 清理回执补充：2026-11-05 00:39:45.946 UTC

本补充取代上文“尚未收到隔离数据库 absent 回执”的当时状态；产品评审与未完成的生产条件不变。本次仅亲读本地清理计划、原始 catalog 和执行回执，没有重新连接数据库、执行删除或复跑产品测试。

已核 `cleanup/mikka-authority-cleanup-receipt.json`：最终清理清单与实际动作恰好为同一组 **30 个**数据库，30 条动作均为普通 `DROP DATABASE`，`force=false`；预先针对这些库检查的 `preDropConnections=[]`，执行后 `remainingOwnedDatabases=[]`，且后置 catalog 中没有这 30 个名字。清理完成时间为 **2026-11-05T00:39:45.946Z**，范围为指定 Vercel sandbox 的 `127.0.0.1:5432`。

初始计划列出 29 个已归属库；最终额外包含 `authority_combined_20261104_2225_e2e`。已再次核对 c29 的 `STATUS-20261104T2231Z.md`，该库确为此前明确记录的本任务 combined fixture 目标；最终回执也记录了这一来源，初始 29 个没有遗漏。

角色没有创建或删除。前置 catalog 与后置回执的三个角色名字完全一致：`postgres`、共享 `mikka_test`、另一任务的 `mikka_lists_integrate_323b14bda6`。`sharedPostgresStopped=false`、`sharedSandboxStopped=false`，没有因清理本任务数据而停止共享服务。

**明确保留的边界：** `approval_e2e_202611042353000000000001` 未能从现有记录证明归属，没有被删除，后置 catalog 仍列出它。资源负责人已接受稍后统一回收共享 sandbox 的安排；本评审不声称整个 sandbox 没有实验数据库，也不把其他任务的数据库列为本任务清理对象。

亲读并计算的原始文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `cleanup/mikka-authority-cleanup-catalog-before.json` | `e2e9eb82cef99ba1f2461c12d5fc64636814eb2aa28df6d789d87780dc00acdc` |
| `cleanup/mikka-authority-cleanup-plan.json` | `f561c43fbf9907103d15ca8d27b88a331a6c7c7902159e3f12faecfb503ed760` |
| `cleanup/mikka-authority-cleanup-receipt.json` | `51c707edab6c22f9ce90d7124ada568081925c52bdcdd31de8a63a64091c001a` |

候选代码仍按已核 8 文件 filemap 保存，原始证据仍按 71 文件 manifest 保存。清理回执和本补充是追加证据，不改变这两个既有清单或候选源码。
