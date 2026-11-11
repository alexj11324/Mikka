# 个人 Run 的 HTTP、文件与审查传输验收

本记录用于复算个人 Workspace 的同一 Run 文件、diff 与审查传输，以及同一任务不同尝试的来源归属。它使用真实 HTTP、PostgreSQL 和完整 daemon；保留的终态 Run 与磁盘源码均为测试夹具，不证明文件由模型生成或原生订阅执行成功。

## 版本与环境

- 测试源码：`593bcc6f96b146f20ecda031b438b89ef44d7f1e`；其后仅添加本记录。
- 隐私依赖：`fd20e54a338455f9812b9125ed600ab34f893832`；main 基线：`43838a6efd6b66472b0c1f221829125bfb31fe34`。
- 云端 Linux，Node 24.19.0、PostgreSQL 17.11，本任务的 loopback 服务端口为 55432。
- 每个场景创建、迁移并清理自己的随机 `*_e2e` 数据库、Git 仓库及工作树。APP 与 Workspace 两个连接目标指向该场景的同一个隔离库；这不是分库部署验收。
- API 经 TCP 监听随机端口，使用正式 request-scoped 适配器、真实存储 session、PAT、普通 local-device credential、PostgreSQL LISTEN、默认 `HttpServerLink` 和磁盘 `RunJournal`。

## 结果与范围

选定的两个文件合计 **27/27，0 skip**：原 shared 场景 13/13，个人场景 14/14。原场景的 226 条断言文本全部保留。

| 场景 | 已验证的行为 |
| --- | --- |
| 个人身份 | `kind=personal`，仅所有者为 active admin，没有 Team 或 Task-Team 绑定；个人任务 private，共享夹具任务 shared |
| 真实写入契约 | 两种夹具均在原 `withTaskWorkspace` 权威租约和同一 APP 事务内创建 Task，再调用生产 `registerTaskResourceAccess`；没有手改 policy 绕过 SQL 默认值 |
| Files 与 mentions | 身份发现、文件 bytes、版本冲突、私密路径拒绝经过真实 commands 与 daemon receipt；错误身份不请求机器源码 |
| Diff 与审查 | daemon 提交完整 Git 源证明，服务端生成公开 patch；旧锚点和缓存文件保留来源，新文件变化不会静默替换旧内容 |
| 同一 Run 的 Task review | 真实 HTTP 读文件、摘要、reviewed 标记及 owner send；反馈持久化为恰好一条 inbox message，幂等重复不增写 |
| 不同尝试 | 同一任务的保留 retry 与 continuation 各有工作树；daemon 重启后返回各自 bytes，默认 Task review 选最新 continuation，旧 Run Files 和旧 reviewRef 保留原来源 |
| 反馈与权限边界 | 对旧尝试发送新反馈返回 409，不写入新尝试的 inbox；外人、错误 Workspace、撤销 session／成员／device credential 均拒绝；个人外人未被伪造为成员 |

注册器位于 [coding-workspace-http-daemon.ts](../../tests/support/coding-workspace-http-daemon.ts)。[原 shared 入口](../../lib/coding-workspace/http-daemon.db.test.ts)与[个人入口](../../lib/coding-workspace/http-daemon-personal.db.test.ts)分别运行在独立 Node test worker，避免已结束的模块级数据库池或认证状态跨场景复用。

接入隐私迁移时，原始 raw-SQL shared 夹具先报 404，而原断言要求成员可读审查元数据。改用正式 Team 登记接口后，原断言原样通过。没有降低成员访问要求、扩大私有草稿可见性或调整 HTTP 断言来消除失败。

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

根类型检查、相关 oxlint、DB runner 25 项契约测试、完整 DB 库存注册以及错误 cause／polling 政策均通过。个人入口已经登记到 `test:coding-workspace-db`；上述 27 项统计仅属于选定的两个文件，不代表整个 package script 的总数。

本任务工作区 `capy-alignment-notes/` 保留原始日志，指纹如下：

| 日志 | SHA-256 |
| --- | --- |
| `personal-daemon-final27.log` | `7979ddb73a4f7ca69a6e915ec51afb8648495b350d022472a89bc84471005363` |
| `personal-daemon-team-registration-red.log` | `2fa440578cc0085e48250b49a0b1d3925b9fdb4841b407e77480bb6759b70fe8` |

## 未验证的执行层

daemon 使用 `harnesses: []`、`modelProbe: false`。全部 Run 明确为保留的终态夹具，断言没有 claim 或 resume。新 retry／continuation 通过真实数据库关联与真实工作树验证来源，未调用创建新尝试的 API，也没有执行 CLI、模型或消费审查消息。

原生 Claude Code／Codex 订阅、实际模型执行、模型产生的文件及继续 API 与这些文件的完整闭环仍需独立验收。策略见[运行时验收](../acceptance.md#live-model-acceptance)；本记录不能代替该层证据。
