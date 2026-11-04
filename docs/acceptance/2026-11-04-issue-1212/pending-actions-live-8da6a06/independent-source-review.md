# Pending live 候选独立复核

复核时间：2026-11-04 22:36 UTC。复核者：realtime_1212。结论：**本次已读范围内未发现阻断项，可以继续父代理负责的最终测试、发布及生产验收。** 这是源码与夹具复核，不代称本人复跑了候选的测试。

## 精确对象

- 基线：`61545e2cfc9cd90e445a442c2762cb5ccfe6b4f1`。
- 候选实际 Git tree：`7f48489dbe8433d5c1bda0fb6be78951b616ad9b`；尚无公开 head，不编造提交链接。
- `integrated-615-filemap.json` / `integrated-615-source/` 17 文件逐个内容及 Git blob 与 `integrated-615-blobs.json` 一致。
- 另从 GitHub 直接读取基线的 19 个相关文件，全部回核 blob 一致，位于 `independent-rt-base615/`、`independent-rt-base615-blobs.json`。因此未把早期 95a263 review 副本误作本次 base。
- 复核包括完整 publisher/cache/GET/component、commit adapter、五类 writer 改动、真实 PG fixture、DOM/TTL fixture，及基线共享 channel/hook/approval-cache/notify。

## 结论依据

### 读取身份与通知 scope

GET 保留原 auth.getSession、按 session.user.id 读取、pendingActionsOutsideToken 过滤和数组 body；新增的 viewer/observedAt header 不赋予新权限。浏览器缓存键包含 owner 和 session，fetch 先校验响应 viewer，再解析列表，因此 cookie 切换不能把其他 owner 响应存进旧键。

列表原本是 owner-wide。publisher 先在保留的 App DB 上按 proposal id + owner 重查 action，再从 Workspace DB 选择该 owner 的 personal workspace 且当前 membership active。没有以当前选中的 team/Bot workspace 扩张可见范围。wire 仅包含 `pending_actions` 和 personal workspace UUID，不包含 proposal id、Bot、input、account、secret 或结果。

个人 scope 未解析时传 null transport scope，借共享慢 fallback 补读，不猜测频道；旧 Worker 没声明支持新 kind 时也保留 fallback。新枚举由 Worker 的既有共享协议导入，需按正常发布流程一并部署，不能用浏览器 pong 假称支持新 kind。

### 五类实际写入

| 写入 | 本次通知位置与静默边界 |
| --- | --- |
| proposeAction | 已 await 实际 pending INSERT 后登记；直接 running 的 writeAccountAction 不通知。 |
| proposeAppToolCall | 已 await 实际 pending INSERT 后登记；未通过 schema/账号/上限的分支无通知。 |
| decidePendingAction | 原 owner + pending + TTL 原子 UPDATE 返回行后登记；非本人 owner / 重复决定无返回行，不通知、不执行；最终 history/result 更新静默。 |
| proposeCredentialOperation | 真实事务所有 INSERT / subagent event 成功后、COMMIT 前登记；重复 pending 与 login 自动授权分支静默，后续失败回滚不会通知。 |
| sweepBrowserMutations | 只有 UPDATE RETURNING 的实际过期行登记；无变更的重复 sweep 与 scrub 历史字段不通知。 |

本次没有增添任何外部发送、Coordinator 决定或审批执行。读取和通知不会重投业务操作。

### COMMIT、savepoint 与数据库上下文

新增 adapter 从 Drizzle session 取实际 observed client，从 request pool proxy 取 held client；不能把内层 Drizzle transaction callback 返回当作外层 COMMIT。沿用 outer COMMIT / ROLLBACK / savepoint effect 状态机，失败提交清理、rollback-to-savepoint 恢复登记集合；已有 SQL 识别范围没有在本 PR 中扩大成通用 SQL parser。

回调保留登记时的 AsyncLocalStorage，在 after 中退出已释放的 held client / transaction context，继续使用原 request DB 和 device authority。它不会为 convenience 切到 default DB。基线的 closed-scope 回归明确关闭后拒绝而不读 default；best-effort sender 捕获此类失效，不让通知失败改变已提交业务结果。

候选真实 PG fixture覆盖：外层 COMMIT 在登记 context 之外；实际 Drizzle 内层 savepoint / 外层 rollback；默认库与 request 库同 proposal UUID、不同 owner；延迟 scheduler；事务内后继 event 失败。两个 owner 的 membership 变更在发送时再读。

生产 caller 范围已与作者复核：credential runtime 从 @/lib/db 取得 pool，后继 submit/clear 沿同 pool；pending decision 也传该 global/request proxy。sweep 的生产入口在 browserAction(pool,...)，未找到绕过此契约的实际裸独立 Pool caller。本次不承诺能从任意独立 Pool 对象自动推导另一个 request DB；新测试证明的是现有真实 global/request proxy 或其 held client 契约。

### TTL 与新的观察时间

账号/app 保留七天，credential/browser 保留五分钟；服务端 TTL 与原子决定条件未改。

requestedAt 在 fetch 前取单调时钟，服务端 observedAt 在读取前取，网络延迟只会使本地期限更保守。共享 channel 不因普通 render、重连或相同 observation 推迟已在运行的 timer。保守 timer 已触发后，只有真实新 HTTP observation 且服务器仍报告未来期限，才安排相同 expiry 的最终检查。服务器已经过期的响应不会制造 immediate revalidation loop。

隐藏页面沿共享 channel 取消定时读取，前台恢复和重连补拉；健康状态取消旧十秒 interval。现有 inline load error / 手动 retry 保留。实际渲染只过滤已过期卡，不修改已冻结 payload/criteria/执行权限。

## 验证口径

本人只读核了测试内容，没有在自己的环境执行作者的 35/35、combined PG 或 production build；那些结果应由父代理据真实回执引用。新 route test 使用 mocked session/filter，所以它证明路由接线，不能单独宣称真实 auth 撤销测试；本次 auth 行为未改变。数据库 fixture 使用实际 tracked migrations/实际 proposals/decisions 和本地 HTTP invalidation receiver，只替代外部 provider/Coordinator wake 与 Next scheduler。

剩余正常发布事项：最终 head/tree 固定、CI 与作者 combined gates 回执、生产构建及实屏、Web deploy 和公开 version pin、网关新 kind 支持、生产真实操作通知及前后台补拉。本文没有将这些尚未完成的事项写成通过。
