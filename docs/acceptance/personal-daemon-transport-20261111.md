# 个人 Run 的 HTTP、文件与审查传输验收

本记录用于复算个人 Workspace 的同一 Run 文件、diff 与审查传输，以及同一任务不同尝试的来源归属。它使用真实 HTTP、PostgreSQL 和完整 daemon；保留的终态 Run 与磁盘源码均为测试夹具，不证明文件由模型生成或原生订阅执行成功。

## 版本与环境

- 27 项 HTTP 验收源码：`e5714cf61abb46c619655f511fd15a530d4804f7`；当时隐私依赖 `ce3f6bbc76d797db8bfda20ec45af87a13b589e3`。
- 最新父分支集成：`8520e5abb7ce9ab54ec4765f4288832b33971792`，合入隐私 `bdd4918dcda2664f330ae9442031dcde9b234169`；变动及最小复验见下文。
- main 验收基线：`5c1e0522483d504f64de07066bcd35f603c44248`，实际执行当时全部 321 项生产迁移。
- 云端 Linux，Node 24.19.0、PostgreSQL 17.11，本任务的 loopback 服务端口为 55432。
- 每个场景创建、迁移并清理自己的随机 `*_e2e` 数据库、Git 仓库及工作树。APP 与 Workspace 两个连接目标指向该场景的同一个隔离库；这不是分库部署验收。
- 阶段一仅部署兼容两种 SQL 默认值的生产登记接口；本验收只执行当前 `drizzle/` 迁移，没有应用 `tests/fixtures/task-acl-private-default.sql`。事务内在登记前读取真实策略，确认当前 SQL 仍将原始 Task 根注册为 shared；随后两种 Workspace 都调用正式登记接口，个人变为 private，Team 保持 shared。
- API 经 TCP 监听随机端口，使用正式 request-scoped 适配器、真实存储 session、PAT、普通 local-device credential、PostgreSQL LISTEN、默认 `HttpServerLink` 和磁盘 `RunJournal`。

## 结果与范围

选定的两个文件合计 **27/27，0 skip**：原 shared 场景 13/13，个人场景 14/14。原场景的 226 条断言文本全部保留。

| 场景 | 已验证的行为 |
| --- | --- |
| 个人身份 | `kind=personal`，仅所有者为 active admin，没有 Team 或 Task-Team 绑定；个人任务 private，共享夹具任务 shared |
| 真实写入契约 | 两种夹具均在原 `withTaskWorkspace` 权威租约和同一 APP 事务内创建 Task；登记前真实策略 shared，生产 `registerTaskResourceAccess` 登记后 personal private／Team shared；没有手改 policy 或应用未来 SQL 默认值 |
| Files 与 mentions | 身份发现、文件 bytes、版本冲突、私密路径拒绝经过真实 commands 与 daemon receipt；错误身份不请求机器源码 |
| Diff 与审查 | daemon 提交完整 Git 源证明，服务端生成公开 patch；旧锚点和缓存文件保留来源，新文件变化不会静默替换旧内容 |
| 同一 Run 的 Task review | 真实 HTTP 读文件、摘要、reviewed 标记及 owner send；反馈持久化为恰好一条 inbox message，幂等重复不增写 |
| 不同尝试 | 同一任务的保留 retry 与 continuation 各有工作树；daemon 重启后返回各自 bytes，默认 Task review 选最新 continuation，旧 Run Files 和旧 reviewRef 保留原来源 |
| 反馈与权限边界 | 对旧尝试发送新反馈返回 409，不写入新尝试的 inbox；外人、错误 Workspace、撤销 session／成员／device credential 均拒绝；个人外人未被伪造为成员 |

注册器位于 [coding-workspace-http-daemon.ts](../../tests/support/coding-workspace-http-daemon.ts)。[原 shared 入口](../../lib/coding-workspace/http-daemon.db.test.ts)与[个人入口](../../lib/coding-workspace/http-daemon-personal.db.test.ts)分别运行在独立 Node test worker，避免已结束的模块级数据库池或认证状态跨场景复用。

早期在随后撤出的 private-default 迁移上，原始 raw-SQL shared 夹具先报 404，而原断言要求成员可读审查元数据。改用正式登记接口后，原断言原样通过。当前阶段一在既有 shared 默认值上复跑，个人夹具也调用同一接口，而非依赖未来 DDL；没有降低成员访问要求、扩大私有草稿可见性或调整 HTTP 断言来消除失败。

## 复算

先按[本地 bootstrap](../local-bootstrap.md)准备允许创建临时数据库的 PostgreSQL 17。以下 URL 是本任务的隔离目标，其他环境替换为自己的 loopback `*_e2e` 库。执行：

```sh
export E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mikka_e2e
export DATABASE_URL="$E2E_DATABASE_URL"
export MIKKA_DATABASE_URL="$E2E_DATABASE_URL"
export REQUIRE_DB=1
export COORDINATOR_SERVICE=0

node --experimental-test-module-mocks --import ./scripts/server-test.mjs \
  --import tsx --test --test-concurrency=1 \
  lib/coding-workspace/http-daemon.db.test.ts \
  lib/coding-workspace/http-daemon-personal.db.test.ts
```

根类型检查、相关 oxlint、DB runner 26 项契约测试、完整 DB 库存注册（83 个 scripts／371 个文件）以及错误 cause／polling 政策均通过。个人入口已经登记到 `test:coding-workspace-db`；上述 27 项统计仅属于选定的两个文件，不代表整个 package script 的总数。

从旧 main `43838a6` 到该 main 基线，daemon、protocol、device auth、execution identity 与 subscription 执行源码没有变动。新的默认个人 Workspace 选择用于没有显式目标的请求；本夹具各请求仍显式指定目标，使用普通 session／PAT／device 身份，不采用独立原生订阅验收 driver 的账号授权。

本任务工作区 `capy-alignment-notes/` 保留原始日志，指纹如下：

| 日志 | SHA-256 |
| --- | --- |
| `personal-daemon-phase1-main321-27.log` | `3d77cb25bd4afa593d2ee726f2c9022c65fc198e5308cc9c20182a48dea2dbb0` |
| `personal-daemon-parent-close5.log` | `a617281e10a34fe80048a7ae4dd7f57fcb29ef26772e593577478085413706f9` |
| `personal-daemon-team-registration-red.log` | `2fa440578cc0085e48250b49a0b1d3925b9fdb4841b407e77480bb6759b70fe8` |

## 父分支观测修正与证据复用

最新父分支只增加 dispatch 测试的真实 Client end 事件观测与验收说明。相对已测 `e5714cf61`，生产 `lib/`、`app/`、`packages/`、生产迁移、package 及本套 HTTP 夹具字节全部相同，因此复用上面的 27 项绑定证据，没有宣称新头重跑了 27 项。

在集成源码 `8520e5abb` 上，使用现有 main5c-cloud 隔离 PostgreSQL 环境最小复验受影响的 dispatch 文件，**5/5、零跳过**；根类型检查、相关 lint、政策及 DB runner **26/26** 再次通过。新夹具在原 zero-session 断言前等待其临时数据库的真实连接 end 事件，没有 sleep、轮询或强制终止 backend；本 PR 自己的 226 条原共享断言没有变化。之后只更新本文档。

## 未验证的执行层

daemon 使用 `harnesses: []`、`modelProbe: false`。全部 Run 明确为保留的终态夹具，断言没有 claim 或 resume。新 retry／continuation 通过真实数据库关联与真实工作树验证来源，未调用创建新尝试的 API，也没有执行 CLI、模型或消费审查消息。

原生 Claude Code／Codex 订阅、实际模型执行、模型产生的文件及继续 API 与这些文件的完整闭环仍需独立验收。策略见[运行时验收](../acceptance.md#live-model-acceptance)；本记录不能代替该层证据。
