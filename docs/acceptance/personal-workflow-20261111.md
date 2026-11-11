# 单人工作流验收记录：2026-11-11

本记录供评审 Capy 对齐改动时核对证据。按照[单人优先决定](../design/decisions/2026-11-11-1400-personal-workflow-before-channels.md)，目标是一个人的发起任务 → 环境与工具 → 执行 → 同一 Run 的 Files/diff → 继续或重试 → 验收。

截至本次记录，个人环境默认值已验证到真实 Run 冻结落库；共享 Workspace 的 Files/diff/review 已通过真实 HTTP、PostgreSQL 与完整 daemon 传输。真实 Claude Code/Codex 模型执行尚未运行，完整个人订阅闭环**无法验证**。这些结果分别成立，不能拼成同一个个人 Run 的端到端通过结论。

## 版本与环境

- Files、daemon、Git、continue/recovery 与离线验收驱动基于 `43838a6efd6b66472b0c1f221829125bfb31fe34`，上述相关源码在运行时相对该版本未改动。
- 执行环境为云端 Linux，Node `v24.19.0`、pnpm `10.34.3`、PostgreSQL `17.11`。
- 基础数据库为本任务的 loopback 隔离库 `127.0.0.1:55432/mikka_e2e`。HTTP/daemon 与 Git 测试另建随机 `*_e2e` 数据库及磁盘 Git 工作树，并清理自己创建的资源。
- HTTP/daemon 测试自行监听随机本地 TCP 端口，使用完整 `startDaemon`、默认 `HttpServerLink` 和磁盘 `RunJournal`，未借用部署站点。
- 个人环境用例来自同轮环境修复工作树，使用真实 action、`queueRun` 与 PostgreSQL；其证据来源单列，不能归入上述未改动的 main 基线。
- 环境代码与正式 UI 验收绑定 public `310a48894926d056c5494fc1ef4bbf203c4db50b`、private UI `c4de45d367d35953b83effcaf46cbd2dc094ad08`。完整 `corepack pnpm build` 后在 `http://127.0.0.1:3000/mikka` 启动正式应用，使用独立 `mikka_environment_310_ui_e2e` 与同 SHA 正常测试账号池；[截图与 HTTP 记录](https://github.com/alexj11324/mikka-hosted-ui/tree/a80b401/evidence/2026-11-11-environments)单列。

## 分层结果

| 层次 | 实际结果 | 证明范围 | 证据边界 |
| --- | --- | --- | --- |
| 个人环境保存 → Project 默认 → Run 冻结 | `test:project-resources-db` **13/13，0 skip**；主 Agent 独立复跑 | `tests/environment-single-workflow.db.test.ts` 经真实 action 保存环境、设置项目默认、读取设置并调用 `queueRun`；核对持久化的环境 ID、revision、setup、variables、Project 与 repository；后续编辑不改旧 Run | 模型目录、连接与 GitHub push grant 使用 fixture；没有启动真实 CLI 或模型 |
| 正式环境设置 UI → HTTP → PostgreSQL | **10 项操作检查通过** | 个人 private Project、明确批准 setup、新建与默认设置、全页刷新、修改 setup 撤销批准、归档恢复保留绑定；本人 GET 200、非成员 403、未登录 401；桌面明暗与 390px 编辑器 | 无 Run 或模型调用，与上一行分开；无运行异常，既有头像 `/avatars/purple.webp` 在三次刷新中返回 404 |
| Files/diff/review：HTTP → PG LISTEN → 完整 daemon → receipt → HTTP | **13/13 通过，0 skip** | 真实 session/PAT/device 身份、TCP HTTP、Git 工作树、文件读取、diff、审查反馈的持久 inbox、session/member/device 撤销拒绝 | fixture 为 **shared Workspace**；留存的 `succeeded` Run 使用 `harnesses: []`、`modelProbe: false`；断言没有 claim/resume 或模型调用 |
| Git status/history/revert/Undo/checkpoint restore | suite 与 6 个子用例通过 | 真实 PostgreSQL 与 Git；包括 stale HEAD/文件、跨租户和不可用机器拒绝 | 使用 retained source，不证明文件由模型生成；所在组合进程整体失败，见 runner 说明 |
| Thread 继续、Owner 权限与 Factory repair budget | suite 与全部子用例通过 | 真实 PostgreSQL 的继续、新 epoch、幂等、权限和修复预算；包括个人历史任务兼容路径 | 模型与 GitHub 使用 fixture；所在组合进程整体失败，不能将组合报绿 |
| Run recovery / prompt-copy，正式 runner | **22/22 通过，0 skip** | 并发恢复、STOP 竞争、续租、重试 fencing、checkpoint 归属和去重 | 仓库现有 `activity-runtime` fixture 提供框架 session/background；真实数据库代码未替换，无 provider 调用 |
| Coding Workspace / cloud-startup 验收驱动契约 | **125/125 通过，0 skip** | 两种固定订阅 case、原生命令证据、清理与 release attestation 的契约校验 | 离线测试，不证明外部订阅或实际发布成功 |

主要源码入口：

- [HTTP 与完整 daemon 回归](../../lib/coding-workspace/http-daemon.db.test.ts)
- [Git 操作回归](../../lib/coding-workspace/git/operations.db.test.ts)
- [Thread 继续回归](../../tests/thread-continue.db.test.ts)
- [Run recovery 回归](../../tests/run-recovery.db.test.ts)及[正式 activity runner](../../tests/fixtures/activity-runtime.mjs)
- [真实订阅验收驱动](../../scripts/acceptance/coding-workspace.mjs)及[驱动测试](../../scripts/acceptance/coding-workspace.test.mjs)

## 复算命令

先按[本地 bootstrap](../local-bootstrap.md)安装依赖并准备允许测试建库的真实隔离 PostgreSQL。下例连接的是本任务已创建的临时库；其他环境需替换为自己的 loopback `*_e2e` 库，不能指向共享或生产数据。命令从仓库根目录执行：

```sh
export E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mikka_e2e
export DATABASE_URL="$E2E_DATABASE_URL"
export MIKKA_DATABASE_URL="$E2E_DATABASE_URL"
export REQUIRE_DB=1
export COORDINATOR_SERVICE=0

node --experimental-test-module-mocks --import ./scripts/server-test.mjs \
  --import tsx --test --test-concurrency=1 \
  lib/coding-workspace/http-daemon.db.test.ts

node --test-force-exit --import tsx \
  --import ./tests/fixtures/activity-runtime.mjs --test \
  tests/run-recovery.db.test.ts lib/run-prompt-copy.db.test.ts

node --import ./scripts/server-test.mjs --import tsx --test \
  scripts/acceptance/coding-workspace.test.mjs \
  scripts/acceptance/coding-workspace-ci.test.mjs \
  scripts/acceptance/cloud-startup.test.mjs
```

Git 与 Thread 首次运行和 recovery 合并在下列命令内，结果为 **54 tests、47 pass、7 fail、0 skip**：

```sh
node --experimental-test-module-mocks --import ./scripts/server-test.mjs \
  --import tsx --test --test-concurrency=1 \
  lib/coding-workspace/git/operations.db.test.ts \
  tests/run-recovery.db.test.ts tests/thread-continue.db.test.ts
```

其中 6 个 recovery 子用例及父用例因误用 runner 报 `after() was called outside a request scope`。核对 [package.json](../../package.json) 的 `test:run-recovery-db` 后，使用前面的正式 `activity-runtime` 命令重跑，22/22 通过。Git 与 Thread 在原组合内通过；保留原组合失败结果，没有修改断言、跳过用例或修改产品逻辑来消除 runner 误用。

## 尚缺的同一 Run 验收

下一次完整验收需将以下证据绑定到同一个个人 Workspace、任务、Run、环境 revision、机器与原生订阅：

1. 通过真实任务入口发起工作，项目默认环境命中，冻结配置进入 Run。
2. daemon claim 并使用冻结的环境、工具和所选原生订阅实际执行。
3. 从该 Run 发现 Coding Workspace identity，读取实际产物、diff 与审查来源。
4. 在同一任务继续或重试，核对新尝试与旧尝试来源、状态和产物归属。
5. 保存验收结果、实际错误与必要清理证据。

真实订阅分别使用官方 Claude Code 的 `claude-haiku-5-5` 和官方 Codex 的 `gpt-6-luna`；各自保留原绑定，一条受阻时继续另一条。该策略见[运行时验收](../acceptance.md#live-model-acceptance)。本次没有调用外部模型、创建付费执行资源、执行外部 GitHub merge 或发布 E2B/生产版本。

只读 readiness 调查进一步确认：两个正在运行的隔离应用库均没有真实订阅、binding、device 或 machine；基础测试库的连接与设备均属 fixture，近期无 daemon 心跳。现有授权 Infisical dev 路径的名称级元数据未提供 BYOS runtime/custody/access 配置或共享 smoke 账号入口；没有读取用户 token 或发送模型 prompt。缺少的是正常 Mikka 用户的真实订阅与 access projection、consumer 绑定、活跃设备和运行身份，不能仅归因于 Claude CLI 不在 PATH，也不能把执行宿主 Codex 身份注入为用户订阅。现成真实订阅驱动还强制选择 team Workspace，不能直接冒充个人闭环证据。

`test:local-loop` 的旧模型分支仍要求 DeepSeek/Flash；[运行时验收说明](../acceptance.md)已明确它不能代表两种官方订阅，DeepSeek/API-key 不再是验收门槛。本次没有补 API key 或发送付费 API prompt。真实 Coding Workspace 驱动绑定生产 origin，CI 入口要求 release/web attestation；本地离线驱动测试不满足这些运行前提。

持久 Drive 文件树另行验证。其 API、owner/Workspace 权限与 blob admission 结果不代替 Run 的 Git 工作树或模型产物；文件响应开始时鉴权也不证明撤权会终止已开始的下载。

## 运行证据指纹

本地完整日志保存在任务工作区的 `capy-alignment-notes/`，由功能 PR 附件或任务证据留存；该目录不是仓库依赖。以下指纹用于核对原始日志，复算以上命令时预期统计保持一致，临时 ID 与时间会变化。

| 日志名 | SHA-256 | 结果 |
| --- | --- | --- |
| `solo-files-http-daemon.log` | `82cb09ea0731246fea90d1061ff2389996abf535053281b437155252cd9de366` | 13/13；日志 UTC 13:42:08–13:42:21 |
| `solo-git-continue-retry.log` | `9e614c5bfae30b3c7a3070a3907879916b108256891f2e1e6c5b245c5f5b5f6a` | 47 pass / 7 fail；日志 UTC 13:43:48–13:44:59 |
| `solo-retry-correct-runner.log` | `9991e7d3f5c81257f285a284e3541b0fcd6d8ef3ba5b98d8d434b36820fd7f64` | 22/22；日志 UTC 13:45:29–13:45:34 |
| `solo-acceptance-driver.log` | `cb12d909c55d082f01d2b418b019acd0a9a2ca622f1701997ccde224286c00bb` | 125/125；测试输出不含 UTC 时间戳 |

所有 UTC 时段均为 2026-11-11，表示日志内观测范围，并非模型执行或部署时段。
