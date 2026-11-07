# Issue 1512：固定 e7 的 HTTP / PostgreSQL 分解诊断

状态：`prepared_not_executed`。这是 Ubuntu 上顺序 HTTP 请求的分解诊断，不是浏览器、Electron、OAuth 提供方或 macOS 的完整登录验收。它不能把各笔顺序计数直接分摊为旧 Native 186 / Web 162 的并发差额，也不改变该次失败结论。

## 固定输入

| 项目 | 固定值 |
|---|---|
| 产品候选 | `e7a1a267335604004586f88e6b530c51b0da286d` |
| 实际编译源码 | `383da169d23b9cb6bfae1951ef862f43919a89c8` |
| 两者 tree | `1e21ead1e8ef95e0354d79c1a5ab76942d760d2f` |
| 编译源码 parents | `6fedfc0ffd879d552d0b861bbd5f2d9f10f4dc3a`、上述候选 |
| Desktop workflow / attempt | `42384327014` / `1` |
| Linux API artifact | `13578149529`，`desktop-api-build-383da169d23b9cb6bfae1951ef862f43919a89c8` |
| ZIP | `47867791` bytes，SHA256 `82926e56d5cc6f04bf19cc0354af2fb7682a61bededec372e00dc5b8d6b0d168` |
| 编译 routes SHA256 | `330f07ced40b3f3c8d683c33791428eed82518e71527b0c1bdf036be2a993f1d` |

`artifact.mjs` 复用已审阅的精确下载器。它验证 repository、run 当前 attempt / success、artifact ID / name / head / digest / bytes、源码 tree / parents，下载地址和 Actions token 只在该独立进程内存中。它只提取这份已核验 ZIP；driver 再独立验证同一个 ZIP 和原始编译 manifest。`.output` 及其内容不作修改。工作流把 token 限定在下载步骤，driver 不接收 token。

新 main、旧 profile、Mac 打包产物都不替代这些输入。Node 运行时固定 `24.22.1`，源 `readCompiledBuild` 保留其 Node 24 主版本合同；实际编译 Node patch 版本会从本次 Linux manifest 原样记录，不冒称与运行时完全相同。pnpm 固定 `10.34.3`。

## 固定 60 请求计划

两端共同的十个 RPC 操作：`desktop.bootstrap`、`bots.pollBots`、`coordinator.pollBotChatSummaries`、`coordinator.syncCoordinatorChat`、`issues.syncIssueList`、`projects.listProjects`、`task-runs.syncThreadList`、`teams.listTeams`、`team-relations.listProjectTeams`、`execution-settings.getBotModelMenu`。每端 issues / thread / chat 各做一次初读和一次使用该端真实返回游标的复读。没有 `refreshBotModelMenu`。

两端八类 GET：默认 `/api/workspace`、`/api/workspace/switcher`、`/api/agent/sessions`、`/api/computer/events`、`/api/settings/preferences`、`/api/devices/enrollment`、`/api/conversations`、`/api/pending-actions`。Computer events 每端依次用 `after=0` 和响应的真实 `cursor`；十进制 bigint 保持字符串，不转成 JS Number。若第一页仍 `hasMore`，本次固定诊断失败，不无限追加请求。列表正文和事件数据不进入报告。

此外保留原诊断的普通 email sign-in / get-session、真实 PKCE begin / 确认页 config + `desktop.session` / return / owned loopback / exchange、每端一个额外 `desktop.session` 比较、每端 local gateway ticket、Native 两笔 task-run 读，以及一个使用已测相同 task / thread / chat 参数的真实 Native `desktop.readBatch`。完整顺序由 `reads.mjs` 的 `REQUEST_PLAN` 固定并在每次测量前核验。

Web preferences / enrollment 和额外 `desktop.session` 是配对成本比较，不能算作默认 Web 登录原本发生的工作。脚本不模拟 React / SWR / Live 的并发次数或 Native batch 调度，不把任何读取移到 macOS 测量窗口之外；这里没有 macOS 测量窗口。只读取 API 的实际协议，不主张 e7 前端 transport 已正确传递所有游标。

所有普通 scope 读取使用原 fixture 的默认选择。`desktop.bootstrap.cacheWorkspace` 与随后无 selector 的 workspace GET 必须同为 fixture team。真实 home 从 workspace GET 取得；owner-wide RPC 和 gateway ticket 必须匹配该 home。没有 workspace switch、伪造 workspace cookie 或授权缓存。Web HTTP context 先关闭，再普通 reauthenticate 创建 Native PKCE 最终保留的同一浏览器 session；不复用被 multi-session 撤销的 bearer。

`getBotModelMenu` 本身可能为新连接发现 catalogue。因此开始 API 计划前，只在原 lease 事务中确认新隔离数据库没有 active connected subscriptions；否则失败，不访问 menu。该只读 harness 检查不在 API PID 计数内，明确列入排除项。菜单只读取，无 provider key、模型调用、enrollment POST、daemon 安装、任务启动或 VM。

## 计数器及完整性

`metrics/db-metrics.cjs` 与 `metrics/db-query-operations.cjs` 逐字节等于固定 e7。实际计数仍在同一个编译 API PID 的 `pg.Client.query` 和连接协议字节边界，没有新 profiler、SQL 读取、body 采样、counter reset 或业务轮询。

唯一诊断副本变化：

- 原 71 项补充来源词表换成 `closed-labels.json` 中独立审阅的 287 项 `queryUnattributedSources`；原 17 项 operation 表不变。原 301 source labels 的目录 SHA256 为 `dd352c9f91b3a1588d989ce974fbf5959c2107b790c234382364e03653812017`。词表绑定精确 e7 source 和实际编译 routes hash。
- 原 `lifecycle-query-counts.mjs` 必须收到完整两个 map；缺失 map、未知额外 key、缺 key、非整数或负数、总和不守恒均失败。原逐 key 单调性、PID / runtime / epoch、时钟和 `unknownReadings` 检查保留。
- 仅 metrics HTTP body 上限从 8192 提至 32768 bytes，以容纳完整 287 项 map。descriptor 仍 8192 bytes，5 秒读取超时和原始日志上限不改；driver 不调用日志读取入口。

`metrics-provenance.json` 给出四个原源码及副本的 bytes / SHA256 / 修改范围。driver 在启动 preload 前对实际 checkout 和副本逐一重算，并核 manifest routes hash。更改只作用于此次测试 preload / reader，不修改产品 `.output` 或历史 Native 17 / 71 产物。

每次 before / after 都先在 RAM 中完整校验，差分也先对全 map 校验。报告的 before / after 只保留固定数值标量；delta 中只输出已校验后的非零 operation / source 项。已知词表中省略项严格为 0；不存在的 / 非法字段绝不当 0。`otherScoped` 和 `noScope` 都仍计入总和，非零时原样报告；动态 Workflow 名称未泛化枚举，不能宣称未知来源必为 0。若响应截断、超限、JSON 错误、数据复位或缺字段，结果失败。

## 报告合同

仅上传三份 JSON，各自小于 256 KiB：

1. `artifact-receipt.json`：固定 artifact / source / tree / digest、已核验 provenance，不含下载 URL 或 token。
2. `desktop-query-decomposition.json`：`version:3`、`productionAcceptance:false`；固定 source、runner、instrumentation、fixture 布尔证明、请求计划、每请求闭合 route / action / purpose / status / 数值 before / after / 非零 delta / 布尔及数值 receipt；未测间隙按同规则单独报告且不减去；最后为原 owned cleanup 结果和 `fullNativeWindowReconciliation:null`。响应中的 owner / workspace / fixture ID、email、cursor、文本、SQL、cookie、bearer 不输出。
3. `runner-receipt.json`：ops revision / 所有执行代码和词表 hash、固定编译 revision、临时 ZIP/TAR 删除结果。PG teardown 只标待 workflow 自身 Stop containers 确认，不预先宣称已完成。

若实际非零桶过多导致报告超过 256 KiB，driver 失败，不截断数据以冒充完整。总查询量应等于 `queryOperations` 非零和，`unattributed` 应等于 `unattributedSources` 非零和。每个请求 / 间隙都保留该证明；后续分析不得将 RPC 次数直接乘成 SQL 数量。

## 执行与清理

工作流草稿：`workflow.yml`。只有 root 审核并授权发布后才可在原 ops branch 使用；此准备过程没有运行它。

部署位置为 `.github/issue1512-sql-profile-e7/`，包含所有 `.mjs`、`closed-labels.json`、`metrics-provenance.json` 与 `metrics/` 四文件。源目录使用固定 383da checkout。原始 `source-contracts.json` / README / 验证日志作为审阅证据，可一并保存，不作为运行时代码输入。

```sh
node --test ops/.github/issue1512-sql-profile-e7/driver.test.mjs ops/.github/issue1512-sql-profile-e7/projection.test.mjs
node ops/.github/issue1512-sql-profile-e7/artifact.mjs "$GITHUB_WORKSPACE/source" "$GITHUB_WORKSPACE/evidence"
node ops/.github/issue1512-sql-profile-e7/driver.mjs --source "$GITHUB_WORKSPACE/source" --artifact-zip "$RUNNER_TEMP/desktop-api-build.zip" --output "$GITHUB_WORKSPACE/evidence/desktop-query-decomposition.json"
```

只有 artifact 步骤使用 scoped `GH_TOKEN`。driver 唯一显式输入环境是新 job 本地 PostgreSQL17 的 `E2E_DATABASE_URL`；真实生成账户由现有 test-account bootstrap / lease 创建。原 8 分钟 driver 总预算、60 秒启动、15 秒 HTTP、8 MiB 响应体、owned process 35 秒 graceful + 5 秒 kill 都保留。

原 finally 顺序逐字节保留：HTTP contexts、owned loopback、精确 nonce / challenge / callback 的 PKCE 行、原 fixture cleanup、lease released / quarantined、owned API、owned local worker、私有账户及 runtime 文件、metrics socket。强杀和任何未证实关闭仍失败。没有账户/服务外的资源枚举。`source-contracts.json` 对九段沿用生命周期代码保存与旧已执行诊断逐字节相同的 hash 证明。

## 离线验证边界

`driver.test.mjs` 检查原有 owner / cursor / PKCE 顺序及新增 scope / route / fixture / 隐私合同。`projection.test.mjs` 运行真实副本 counter（仅 Module / HTTP seam 假实现，不 listen、不 PG），证明新标签及两个 unknown 桶均计入；运行实际复制 reader 的完整响应 / 超限 / 截断 / 缺字段 / 不守恒 / 非单调反例。它们不是实际 PostgreSQL 或 macOS 计数结果。

初次 `tests.initial.tap` 有 19 条断言通过，但 fake HTTP `destroy()` 非幂等造成 file-level 异步异常，整轮 exit 1；该原输出保留。修正 seam 与 Node 实际销毁语义一致后，`tests.tap` 是 19 / 19、exit 0。`validation.json` 绑定最终源码及所有验证输出；不掩盖第一次失败，也不将 source-only 通过写成生产通过。
