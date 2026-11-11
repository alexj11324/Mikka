# #1687 领域模型迁移与验收

本说明用于 Project v2、稳定 Task 编号、Team / Project 生命周期和仓库环境绑定的发布。代码与正常迁移入口是执行依据；设计背景见 [领域模型决定](../design/decisions/2026-11-07-2300-work-domain-model.md)，发布规则见 [开发工作流](../dev-workflow.md)，迁移机制见 [migration bootstrap](../migration-bootstrap.md)。

发布记录中的 SHA、实际测试数和生产观测结果由发布负责人填写。本文提供操作步骤，不表示生产验收已经完成。

## 1. 入口与双数据库顺序

沿用部署的正常 `pnpm build`。它在应用构建及类型检查成功后调用 `scripts/migrate.mjs`。本地隔离数据库的迁移复现使用：

```sh
MIGRATE=1 pnpm migrate
```

该命令只在已配置的隔离环境执行；生产通过正常发布运行同一个迁移器。不要另开一套 DDL、修改 `schema_migrations`、使用 schema push 或把生产数据库当作 smoke fixture。迁移器输出 `migrate: skipped` 不能作为迁移成功证据。

| 目标 | 配置 | 本次有关的数据 |
| --- | --- | --- |
| Application，简称 APP | `MIKKA_DATABASE_URL` | Task 可信归属、Run / Factory / artifact 归属、稳定编号和别名、Project 决策历史 |
| Workspace，简称 WS | `DATABASE_URL` | Workspace / 成员 / Team、Project 本体和关系、Team 编号别名、Project 仓库与 Environment、生命周期审计 |

两者可以指向不同数据库。不要用 APP 数据库内跨表 JOIN 假定能读取 WS 表。Preview 使用其显式配置的 `DATABASE_URL`，不会回退到生产连接。

迁移器先校验两个目标的完整历史，再依目标执行各自的有序迁移。当前顺序是 APP 结构迁移、WS 结构迁移，然后跨库回填；每个文件 / 批次独立提交，不是跨库原子事务。两个目标均完成结构迁移后，以下回填顺序不可交换：

1. `backfillTaskWorkspaces`：先用可信关系绑定 P0 Task 归属，同时补有证明的 Run / Factory / artifact 归属。没有充分证明的 Task 保持 `ownershipState='pending'`、`workspaceId IS NULL`。
2. `backfillTaskIdentifiers`：先分批补齐已绑定 Task 的空租户别名，并导入有同 Task、同 Workspace、Run 执行者匹配证明的历史 publication（包括协作者执行的 Run）。这一步也处理已经发号的 Task。随后只给尚无 `issuedIdentifier` 的已绑定 Task 发放稳定编号，并复制匹配 Task、Workspace、历史创建者的 Team 别名。首发优先采用最早的可信 publication；已有稳定编号和已发布 Run 的编号不重写。
3. `backfillProjectV2`：在可信 Task 归属基础上推导 Project 的唯一 Workspace，建立 `workspace_project_tasks` 和成员关系，并写完成回执。
4. `resource-acl-backfill.mjs`（治理层 #1851）：在 `backfillProjectV2` 之后运行。脚本检测到 `workspace_projects."workspaceId"` 与 `workspace_project_tasks` 时，只使用 canonical 归属和 canonical 关系；`workspaceId IS NULL` 的 Project 注册为 quarantined，不按 Team 链接、创建者或名称猜测。只有 Project v2 列/关系尚未部署时才回退到旧 Team-link/owner 推断，避免同一次发布出现第二套 Project 身份。未注册 ACL 的 Project 对普通读取不可见，因此必须在开放读取前完成。

日志对应以下结果：

```text
migrate: task workspace ownership bound=<本轮绑定数> pending=<本轮待处理数>
migrate: task aliases tasks=<累计处理 Task 数> bound=<累计补租户别名数> publications=<累计导入发布别名数>
migrate: stable task identifiers issued=<本轮补齐数>
migrate: projects bound=<本轮绑定数> tasks=<本轮建关系数> pending=<本轮待处理数>
```

它们是本轮工作量，不能代替下文的数据库存量统计。别名进度只在有待补齐批次时输出，已完整的行不重复 UPDATE。没有证据的记录留在隔离区是预期行为；把它们改成“可见”来清零不是验收。

本次迁移文件的目标如下；以后若新增修复迁移，保留原记录，在发布证据中追加新文件。

本次集成版本沿用 P0 已进入 main 的 `20261109035000`–`20261109035003` 名称，本 Epic 九个文件改名为 `20261111030000`–`20261111030008`，排在 main 已发布的 `20261111020000` 之后；槽位预留 PR #1889 的 `20261111010000`–`20261111010008` 未单独进入 main，不再重复引入。所有 SQL 内容逐字不变；P0 ownership 外层 guard、下游回填入口与历史 fixture 边界同时使用新文件名，避免改名后静默跳过回填。上述区间是当前公开协调候选；若部署账本已记录其他名称，本 PR 必须继承实际已发布的名称，不能把同一 SQL 再次作为新迁移执行。已进入 main 或部署账本的迁移不参与改名。

| 文件 | 目标 |
| --- | --- |
| `20261109035000_task_workspace_ownership.sql`（P0 前置） | APP |
| `20261111030000_project_v2.sql` | WS |
| `20261111030001_task_identity.sql` | APP |
| `20261111030002_task_identity_aliases.sql` | WS |
| `20261111030003_team_lifecycle.sql` | WS |
| `20261111030004_project_resources.sql` | WS |
| `20261111030005_project_lifecycle.sql` | WS |
| `20261111030006_project_history_retention.sql` | APP |
| `20261111030007_task_alias_tenant.sql` | APP |
| `20261111030008_project_writer_fence.sql` | WS |

### 1.1 新旧服务交叠期间的 Project 写入

WS 结构迁移会先安装 Project 写入围栏，再运行回填。已有待修复 Project 保持原样；新建 Project 必须显式提供 Workspace，并通过 canonical 表建立 Task 关系。一个 Project 完成回填或由新 API 创建后，数据库拒绝再修改旧 `issueIds` 或历史创建者。旧 `lead` / `properties.members` 的更新也必须来自已通过 Workspace、PAT、Project 权限和活跃成员检查的新 API 事务；事务局部的版本标记本身不授予权限，提交后不保留在连接池会话中。

迁移先完成、旧服务尚未退出时，旧 Project 创建或关系／负责人／成员更新可能明确失败，旧服务会返回已有保存失败错误；不得将它记为保存成功后等待新读路径“同步”。即使旧 UPDATE 已经排队等待回填的行锁，回填提交后仍会被围栏拒绝。发布负责人应记录这一短暂兼容窗口，确认新 SHA READY 后使用正常新 API 验证保存。不要关闭触发器、改回旧写入或双写 JSONB 规避失败；失败的旧请求由用户在新版本重试。

## 2. 归属、隔离记录和回执

Task 的创建者、旧 `scope`、Project 的名称，都不能单独证明 Workspace 归属。P0 回填使用经核验的 Team / Project 关系和既有执行来源等结构证据；Project 回填检查显式 Workspace、合法 Team 关系及其旧 Task 列表中所有 Task 的可信归属。不同证据必须一致，目标 Workspace 必须存在。Project 的旧 `issueIds` 只作迁移输入，运行时关系以 `workspace_project_tasks` 为准，不按名称恢复关系。

| 记录 | 意义 | 验收处理 |
| --- | --- | --- |
| APP `issue_workspace_repairs` | `missing_evidence`、`conflicting_evidence`、`missing_workspace` 等 Task 归属问题及证据 | 按原因记录数量；逐项分配后续处理责任，保持隔离 |
| WS `workspace_project_repairs` | Project 归属或 Task 关系问题及证据 | 同名不合并；冲突 Task 不任选一个 Project |
| WS `workspace_project_v2_migrations` | 一个 Project 已完成 canonical 关系迁移，或本来就是新建的 canonical Project | 重跑不得把旧 JSONB 中的关系重新加回来 |
| APP `task_identifier_aliases` | 已发放编号、历史 owner / Team / publication / Linear 编号 | 保留旧入口解析能力，不靠改写 Run 维持兼容 |
| WS `mikka_task_identifier_aliases` | Team 编号历史快照 | Team 改名、改标识或移除分组后仍保留 |

Project 待修复原因包括 `invalid_task_ids`、`conflicting_task_projects`、`conflicting_evidence`、`unresolved_tasks`、`missing_evidence`、`missing_workspace`。其中多 Project 声称拥有同一 Task 的情况会进入修复队列，不由遍历顺序决定赢家。旧负责人 `me` 仅在历史 Project 创建者仍是目标 Workspace 活跃成员时映射到该用户，不映射到执行迁移的人。

目前没有通用的“指定归属后立即修好”API。无法自动确定的记录需要独立的证据审查和批准的修复变更：说明真实 Workspace、关系来源、冲突为何消除、受影响 UUID 和兼容要求，再通过有回归覆盖的修复路径发布。不要按 owner 的个人 Workspace 猜测，不要用手工 UPDATE、删除 repair 记录或伪造 receipt 绕过审查。非空的可信 Workspace 归属受不可转移约束保护。

## 3. 发布前后只读证据

以下查询只读。使用运维已授权的连接环境，不把连接串、用户内容或完整 `agentDefinition` 放进日志。示例通过 `PGDATABASE` 传入连接配置，通过只读会话限制执行范围；每条 `psql` 的失败必须阻止验收继续。

### 3.1 迁移账本和隔离存量

迁移完成后，在 APP 执行：

```sh
PGDATABASE="$MIKKA_DATABASE_URL" PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' \
  psql -X --set=ON_ERROR_STOP=1 <<'SQL'
SELECT name, "appliedAt" FROM schema_migrations
WHERE name IN (
  '20261109035000_task_workspace_ownership.sql',
  '20261111030001_task_identity.sql',
  '20261111030006_project_history_retention.sql',
  '20261111030007_task_alias_tenant.sql'
) ORDER BY name;

SELECT "ownershipState", count(*) AS tasks FROM issues GROUP BY "ownershipState" ORDER BY 1;
SELECT reason, count(*) AS repairs FROM issue_workspace_repairs GROUP BY reason ORDER BY reason;
SELECT count(*) AS pending_without_repair FROM issues i
WHERE i."ownershipState"='pending'
  AND NOT EXISTS (SELECT 1 FROM issue_workspace_repairs r WHERE r."issueId"=i.id);
SELECT count(*) AS bound_without_identifier FROM issues
WHERE "ownershipState"='bound' AND "issuedIdentifier" IS NULL;
SELECT count(*) AS issued_without_alias FROM issues i
WHERE i."ownershipState"='bound' AND i."issuedIdentifier" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id AND a.identifier=i."issuedIdentifier"
    AND a."ownerId"=i."userId" AND a."workspaceId"=i."workspaceId"
);
SELECT count(*) AS published_identifier_without_alias FROM run_publications p
JOIN issues i ON i.id=p."issueId" AND i."ownershipState"='bound'
JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=i.id AND r."userId"=p."userId"
  AND r."workspaceId"=i."workspaceId"
WHERE p.identifier IS NOT NULL AND p.identifier<>'' AND NOT EXISTS (
  SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id AND a.identifier=p.identifier
    AND a."ownerId"=i."userId" AND a."workspaceId"=i."workspaceId"
);
SELECT count(*) AS bound_alias_without_tenant FROM task_identifier_aliases a
JOIN issues i ON i.id=a."issueId" AND i."userId"=a."ownerId" AND i."ownershipState"='bound'
WHERE a."workspaceId" IS NULL;
-- Report quarantined/conflicting receipts separately: they are not authority
-- to issue an identifier or make an old alias visible.
SELECT CASE
  WHEN i.id IS NULL OR i."ownershipState"<>'bound' THEN 'unresolved_task'
  WHEN r.id IS NULL OR r."issueId" IS DISTINCT FROM i.id OR r."userId" IS DISTINCT FROM p."userId" THEN 'mismatched_run'
  WHEN r."workspaceId" IS NULL THEN 'unresolved_run'
  WHEN r."workspaceId" IS DISTINCT FROM i."workspaceId" THEN 'conflicting_workspace'
  ELSE 'verified'
END AS publication_evidence, count(*)
FROM run_publications p LEFT JOIN issues i ON i.id=p."issueId" LEFT JOIN agent_runs r ON r.id=p."runId"
WHERE p.identifier IS NOT NULL AND p.identifier<>'' GROUP BY 1 ORDER BY 1;
SELECT count(*) AS conflicting_alias_projection FROM task_identifier_aliases a
JOIN issues i ON i.id=a."issueId" WHERE a."ownerId" IS DISTINCT FROM i."userId"
  OR (a."workspaceId" IS NOT NULL AND a."workspaceId" IS DISTINCT FROM i."workspaceId");
SELECT 'agent_runs' AS relation, count(*) AS unbound FROM agent_runs WHERE "workspaceId" IS NULL
UNION ALL SELECT 'factory_tasks', count(*) FROM factory_tasks WHERE "workspaceId" IS NULL
UNION ALL SELECT 'artifacts', count(*) FROM artifacts WHERE "workspaceId" IS NULL;
SQL
```

`bound_without_identifier`、`issued_without_alias`、`published_identifier_without_alias`、`bound_alias_without_tenant` 应为 0；这些统计限于可信的 bound 数据。`pending_without_repair` 应为 0；出现非零应检查回填是否中断，以及查询期间是否有旧写入路径产生新行。publication 的未确定 / 冲突证据、错误 owner 或非空冲突 Workspace 的别名需单列审查，回填不会覆盖它们，也不要求它们能被解析。派生表未绑定的历史记录不一定能自动修复，需与可信来源和 Task 隔离存量一起审查，不能按总数强行绑定。

在 WS 执行：

```sh
PGDATABASE="$DATABASE_URL" PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' \
  psql -X --set=ON_ERROR_STOP=1 <<'SQL'
SELECT name, "appliedAt" FROM schema_migrations
WHERE name IN (
  '20261111030000_project_v2.sql', '20261111030002_task_identity_aliases.sql',
  '20261111030003_team_lifecycle.sql', '20261111030004_project_resources.sql',
  '20261111030005_project_lifecycle.sql', '20261111030008_project_writer_fence.sql'
) ORDER BY name;

SELECT count(*) FILTER (WHERE "workspaceId" IS NOT NULL) AS bound_projects,
       count(*) FILTER (WHERE "workspaceId" IS NULL) AS quarantined_projects
FROM workspace_projects;
SELECT reason, count(*) AS repairs FROM workspace_project_repairs GROUP BY reason ORDER BY reason;
SELECT count(*) AS receipts FROM workspace_project_v2_migrations;
SELECT count(*) AS bound_without_receipt FROM workspace_projects p
WHERE p."workspaceId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_project_v2_migrations m WHERE m."projectId"=p.id
);
SELECT count(*) AS quarantine_without_repair FROM workspace_projects p
WHERE p."workspaceId" IS NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_project_repairs r WHERE r."projectId"=p.id
);
SELECT count(*) AS invalid_project_task_relation FROM workspace_project_tasks t
LEFT JOIN workspace_projects p ON p.id=t."projectId"
WHERE p.id IS NULL OR p."workspaceId" IS DISTINCT FROM t."workspaceId";
SELECT "issueId", count(*) FROM workspace_project_tasks
GROUP BY "issueId" HAVING count(*) > 1;
SQL
```

后三类异常计数（缺回执、缺修复记录、Project 关系错租户）应为 0，重复 Task 查询应返回空集。历史 `mikka_team_projects` 外键采用 `NOT VALID` 保留冲突证据，不能把“数据库里仍有旧 Team 链接”当成授权依据，也不要为了让计数好看直接删除这些证据。

APP / WS 分库的 Task 关系一致性需要分别读取后配对。可在授权的验收样本上导出 WS 的 `issueId,projectId,workspaceId` 和 APP 的 `id,workspaceId,ownershipState`，按 UUID 比较：每个 canonical 关系都应对应同一 Workspace 的 `bound` Task。数据库测试覆盖分库执行；不要在生产临时装跨库扩展来执行 JOIN。

### 3.2 已发布编号与 Run 快照：同一批 UUID 前后比较

选择一组已授权、包含已发布历史的 Task UUID，并包含有旧 Run 的 Task。若已有带 `projectExecution` 的 Run，也包含一个这类样本。第一次上线前没有该类历史快照时，将该项记为“不适用”，不能填成旧快照兼容性已被生产证明。运行中的正常业务会新增行；下面比较只要求发布前已存在的行保持一致，允许发布后新增行。

在迁移前保存下面的函数和变量；在迁移后使用同一组 UUID、同一目录再执行一次。将示例 UUID 替换为授权样本 UUID，保留 PostgreSQL 数组格式。

```sh
umask 077
export DOMAIN_EVIDENCE="$PWD/.cache/domain-model-rollout"
export DOMAIN_TASK_IDS='{00000000-0000-0000-0000-000000000001}'
mkdir -p "$DOMAIN_EVIDENCE"

domain_snapshot() {
  local domain_phase="$1"
  case "$domain_phase" in before|after) ;; *) return 2 ;; esac
  PGDATABASE="$MIKKA_DATABASE_URL" PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' \
    psql -X --quiet --set=ON_ERROR_STOP=1 --set=task_ids="$DOMAIN_TASK_IDS" \
    > "$DOMAIN_EVIDENCE/$domain_phase-task.csv" <<'SQL' || return
COPY (
  SELECT id, coalesce(to_jsonb(i)->>'workspaceId','') AS workspace_id,
    coalesce(to_jsonb(i)->>'issuedIdentifier','') AS issued_identifier
  FROM issues i WHERE id=ANY(:'task_ids'::uuid[]) ORDER BY id
) TO STDOUT WITH (FORMAT csv, HEADER true);
SQL
  PGDATABASE="$MIKKA_DATABASE_URL" PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' \
    psql -X --quiet --set=ON_ERROR_STOP=1 --set=task_ids="$DOMAIN_TASK_IDS" \
    > "$DOMAIN_EVIDENCE/$domain_phase-publication.csv" <<'SQL' || return
COPY (
  SELECT "runId" AS id, "issueId", identifier, branch, "baseBranch", "remoteKey"
  FROM run_publications WHERE "issueId"=ANY(:'task_ids'::uuid[]) AND status='published'
  ORDER BY "runId"
) TO STDOUT WITH (FORMAT csv, HEADER true);
SQL
  PGDATABASE="$MIKKA_DATABASE_URL" PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' \
    psql -X --quiet --set=ON_ERROR_STOP=1 --set=task_ids="$DOMAIN_TASK_IDS" \
    > "$DOMAIN_EVIDENCE/$domain_phase-run.csv" <<'SQL' || return
COPY (
  SELECT id, "issueId", "agentDefinition"->'projectExecution' IS NOT NULL AS has_project_snapshot,
    md5(jsonb_build_object('agentDefinition',"agentDefinition",'baseBranch',"baseBranch")::text) AS frozen_digest
  FROM agent_runs WHERE "issueId"=ANY(:'task_ids'::uuid[])
    AND status IN ('succeeded','stopped','failed','cancelled')
  ORDER BY id
) TO STDOUT WITH (FORMAT csv, HEADER true);
SQL
}

domain_snapshot before
```

只输出编号、UUID、仓库键和快照摘要，不输出执行定义、变量或密钥。摘要用于一致性比较，不是安全签名。`to_jsonb(i)` 让第一次上线前尚无新列的 Task 查询也能运行。Run 摘要特意不包含 P0 合法补齐的顶层 `workspaceId`，仍覆盖原有 `executionIdentity`、已有 `projectExecution`、配置快照和 base branch。已完成 Run 的状态和 publication 的 PR 状态不参与比较。

迁移完成后：

```sh
domain_snapshot after
python3 - <<'PY'
import csv
import os
from pathlib import Path

root = Path(os.environ['DOMAIN_EVIDENCE'])
expected = {value.strip() for value in os.environ['DOMAIN_TASK_IDS'].strip('{}').split(',') if value.strip()}
def read(phase, kind):
    with (root / f'{phase}-{kind}.csv').open(newline='') as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == len({row['id'] for row in rows}), f'{phase}/{kind}: duplicate UUID'
    return {row['id']: row for row in rows}

for kind in ('task', 'publication', 'run'):
    before, after = read('before', kind), read('after', kind)
    assert before, f'{kind}: choose a nonempty historical sample'
    if kind == 'task':
        assert set(before) == expected, 'task: sample UUID missing before migration'
    for identity, old in before.items():
        assert identity in after, f'{kind}: historical row disappeared: {identity}'
        new = after[identity]
        if kind == 'task':
            for field in ('workspace_id', 'issued_identifier'):
                if old[field]:
                    assert old[field] == new[field], f'task: immutable {field} changed: {identity}'
        else:
            assert old == new, f'{kind}: published identity or frozen configuration changed: {identity}'
    print(f'{kind}: preserved {len(before)} historical rows')
PY
```

保留脚本输出、样本数量和摘要文件。公开 Issue / PR 只记录汇总和证据位置，不贴数据库内容。样本比较说明所选历史的前后稳定性；全量完整性还依赖迁移回归、不可变约束和 3.1 的异常查询，不能把一个样本表述成所有生产数据均已审计。

## 4. 幂等和失败恢复

先在隔离库的真实旧数据形状上通过正常迁移入口迁移，再重跑同一命令。验收以下结果：

- `schema_migrations` 文件集合和既有 `appliedAt` 不变。
- 已绑定的 Task / Project Workspace、已发放的 Task ID、历史 publication 和冻结 Run 摘要不变。
- 无新增业务写入、无新增可信证据时，第二轮 `bound` / `issued` / Project Task 新建数量为 0；未知归属的 `pending` 可以保持非零。
- 已有 `workspace_project_v2_migrations` 回执不被替换。通过 canonical API 移走或解除关系的 Task，不因旧 `issueIds` 仍有它而被重新挂回。
- repair 的 `checkedAt` 可随重检更新；这不表示归属已获准，也不属于业务历史被重写。

若中途失败，保存哪个目标、文件或回填批次失败的日志，以及两个目标的只读账本。不要假定失败代表前面的提交均已撤销。修正代码 / 有审查的补充迁移后继续正常部署，由账本和回执跳过已完成步骤。遇到未记录但疑似已提交的 DDL，应按现有迁移器的历史校验诊断处理，不自行补账本或直接重放文件。

安全恢复以 fix-forward 为主。不得通过回退 Workspace ACL、恢复按 creator / 名称授权、把 pending 数据当成个人数据，或把 Project canonical 关系切回 JSONB 来恢复服务。若必须回退应用版本，先证明该版本能理解现有双库 schema 并保持当前权限边界；不能证明时修复当前版本。数据回填不会把未知归属变成有效授权。

## 5. Team 与 Project 生命周期验收

以下变更操作在隔离验收账户和真实 HTTP / RPC 流程中验证。生产观测以已有数据的只读查询、部署状态及正常业务读路径为主，不创建再删除客户 Task / Team / Project 来做破坏性 smoke。

| 操作 | 应保留 / 应拒绝 |
| --- | --- |
| Team archive / restore | 保留 Team UUID、Task 与 Project 关系、稳定 Task 编号、历史别名和 Run；归档期间拒绝新增绑定 |
| Team remove grouping | 删除 Team 分组本体及其分组关系，保留 Task / Project / Run、编号别名及生命周期审计；这是移除分组，不是归档恢复入口 |
| Team hard delete | 只允许符合空对象检查的 Team；非空时先返回影响和拒绝，不级联删除 Task |
| Project archive / restore | 保留 UUID、业务 status、Task 关系、仓库环境绑定、事件 / 决策 / Run 历史；archive 是独立标记，restore 明确恢复该标记 |
| Archived Project 新写入 / 执行 | 拒绝普通修改、新绑定和新的 Run admission / claim；已有历史仍可读取，历史快照不会因 restore 重写 |
| Project hard delete | 管理员、当前 revision、名称确认均通过后，仍须所有内容与历史计数为零；包括 Task、Team、成员、仓库环境、事件、依赖、milestone、旧 Task 引用、Factory、Run 和决策 |

正常创建的 Project 会有创建事件，因此通常应使用归档；“已移走全部 Task”不等于“无历史可硬删”。硬删不会静默改成归档，失败后也不应该通过清空历史来绕过检查。

仓库和环境权限验收还必须区分配置和执行：零 Project 仓库绑定继承既有允许范围，非零绑定与 Workspace policy、执行用户当前 GitHub 权限取交集；Workspace `restricted` 空列表拒绝所有仓库。配置保存成功不证明外部 GitHub 或实际模型执行成功。新的 Run 固定当时的 Project / policy / repo / branch / environment 快照，后续领取仍校验当前许可；旧无快照 Run 不会被追加入新的 Project 环境。

## 6. 隔离环境验收与发布记录

使用 [本地运行环境](../local-runtime.md) 配置 Node 24、PostgreSQL 17、隔离 `*_e2e` 数据库和测试账户。不要伪装 CI 环境变量通过保护。数据库 suite 的 skip 不是通过证据。

现有入口包括 `pnpm test:migrations`、`pnpm test:project-v2-db`、`pnpm test:task-identity-db`、`pnpm test:project-resources-db`、`pnpm test:domain-lifecycle-db` 以及 Team / Workspace 和 Project Map 数据库回归。具体通过数和已运行文件从实际日志填写。

`test:project-v2-db` 使用真正分开的 APP / WS 数据库，覆盖结构迁移、真实回填锁等待、排队旧 writer 的拒绝和新 API 的兼容写入。它还直接启动 `scripts/seed-acceptance-demo.mjs`：脚本只接受已存在的 Acceptance Guest，使用确定的演示 Workspace UUID 创建 WS 成员、APP bound Task 和 canonical Project 关系／回执，重跑保留用户已编辑的内容、已解除关系和编号。脚本不会认领归属未知或其他 Workspace 的旧演示记录；这类数据仍须走经审查的迁移修复。该脚本是隔离验收数据工具，不是生产 repair API。

真实 HTTP / RPC 验收直接复用现有本地 runner 的 Item 11：

```sh
LOCAL_LOOP_ITEMS=11 pnpm test:local-loop
```

该项复用测试账户与 Workspace 治理 fixture，在 `workspace-governance-acceptance.mjs` 末尾运行 `work-domain-acceptance.mjs`。不调用模型，不启动本项不需要的 daemon。覆盖同名不同 UUID Project、稳定负责人 / 成员、Task 关系与改名、跨租户拒绝、0 / N 仓库配置、Team 生命周期、Project 归档恢复及历史保留、Task / Factory / Run 状态投影。拒绝路径断言实际 HTTP / RPC 错误码，并读取数据库确认没有残留副作用；不是仅验证正向返回 200。

保留 `.cache/dev-local/progress.jsonl` 中本次 `runId` 的 `item11-workspace-governance` 证据和 runner 的最终退出状态。测试账户和原始服务日志遵循现有 runner 的脱敏和访问限制。Item 11 的零模型调用验收，不替代需要外部服务的既有执行验收。

| 发布证据 | 负责人填写 |
| --- | --- |
| Issue / PR | #1687 / 待填写 |
| 被验证候选 SHA / 最终 merge SHA | 待填写 |
| APP / WS 是否真实分库，隔离 PostgreSQL 版本 | 待填写，不记录连接串 |
| 空库迁移 / 旧数据回填 / 重跑幂等结果 | 待填写 |
| DB suite 实际 passed / failed / skipped 数和日志位置 | 待填写 |
| HTTP Item 11 的 runId、最终退出状态和证据位置 | 待填写 |
| Task / Project pending 原因统计及已审查处置 | 待填写 |
| 已发布编号、Run 快照前后比较数量与结果 | 待填写 |
| 生产部署 READY 时间、服务实际 SHA、正常只读观测 | 待填写 |
| 外部服务相关验收是否适用及其独立证据 | 待填写 |

发布完成需同时确认部署 READY、实际服务 SHA 与合并结果一致，以及迁移日志和只读完整性检查符合上述标准。未知归属有隔离和可追踪处置，不能用“测试通过”省略它们，也不能因要求清零而降低权限边界。

## 7. 真实订阅与项目资源的生产验收入口

现有 `Production smoke` 工作流增加了本 Epic 的显式手动模式，驱动为 `scripts/acceptance/work-domain-production.mjs`。只在真实 `main` 的 `workflow_dispatch` 中运行；`domain_model_sha` 必须同时等于该 workflow 的 SHA 和生产 `/mikka/api/version` 返回的完整 SHA。输入检查和实际部署版本检查先于凭据读取。已有 GitHub OIDC 身份只读取共享 smoke 账号的邮箱和密码，不把生产数据库、GitHub 或模型凭据交给外部执行环境。

| `domain_model_mode` | 行为及条件 |
| --- | --- |
| `preflight` | 正常登录并验证唯一授权 Shared Workspace，读取角色、Project、Environment、Bot、GitHub 仓库许可及小模型订阅候选；不提交模型工作。可不传 scope，先取得可用身份和资源 ID。 |
| `provision` | 明确选择 Workspace、Bot、Mikka 仓库、base branch 和两订阅后，以正常 API 新建并保留领域模型审阅 Project 和受限 cloud/any Environment，或使用显式给定且配置一致的已有 Environment；不修改既有 Project 的绑定。要求当前 Workspace admin；不调用模型。 |
| `active` | 使用完整明确的 Project、Environment、仓库、Bot 与订阅 scope，创建两个保留的实际审阅 Task，分别以官方 Claude Haiku 5.5 与 Codex GPT-6 Luna 固定 Profile 通过正常 Coordinator 派发并读取运行证据。 |

`domain_model_scope` 是严格 JSON 对象，字段为 `workspaceId`、`botId`、`repositoryKey`、可选 `baseBranch`、`projectId`、`environmentId` 和 `models`。`models.claude` / `models.codex` 分别含对应的 `connectionId` 和可选的已存在固定 `profileId`。所有 ID 都来自本次正常 API 预检；仓库键沿用 `v2/github.com/owner/repo`。active 必须有 Project / Environment ID，provision 必须有 base branch 且不能指定待覆盖的 Project ID。工作流回执中的 provision scope 可作为下一步 active 输入。

普通 member 可以执行其有权使用的已配置资源，但不能配置 Workspace Environment 或 Project 资源绑定。首次上线缺少资源且 smoke 账号只是 member 时，记录 `provision_permission` 和精确缺少的绑定，由已有工作区管理员通过正常产品接口完成配置后再验收。不得提高 smoke 角色、借用 Alex 会话、改数据库记录或放宽 API 权限来让测试通过。

每条订阅只提交一次初始工作，使用确定的 submission ID。Task 内保留本次配置指纹，重复操作会先拒绝；网络超时不能证明请求未执行，也不是重新生成 Task 或 submission ID 的理由。两条订阅独立记录失败，不用另一模型重试已绑定的任务。正常 Factory review / verify 仍可能产生额外 Run；其模型只能来自预检确认的固定小模型订阅集合，逐个记录实际 Run，不把两条 Task 宣称为只有两次模型调用。平台内建 Decision judge 沿现有规则独立记录，不算作 CLI 订阅路径证据。

驱动不改变账号的 API-key fallback 设置。固定订阅 Profile 不允许执行源 fallback；Coordinator chat 的付费 fallback 则依据已有公开 key catalog 核实。只有能够证明所选小模型不存在可达的付费 API-key fallback 时才提交；未知配置或超出小模型范围的 enabled Profile 必须在提交前拒绝。

报告保留实际 Task、Project 和环境；清理只停止可归属于本次提交的 Run、回收其机器、归档本次新建的专用 Profile，并恢复自己的会话 Workspace 后退出。未知派发结果或无法证明的运行归属必须保留恢复信息并报告清理未完成，不能把普通 stop ACK 当成资源已关闭。

active 的成功状态仍是 `execution_observed_pending_snapshot_review`：负责人还须将报告中的实际 Task / Run / Project UUID 与第 3 节的授权只读 APP / WS 证据配对，核对真实 repository、base branch、Environment 配置快照和历史前后摘要。只读任务按现有 daemon 规则不执行 Environment setup，因此本入口不证明生产 setup 命令已执行；setup 的实际执行由隔离的 queue / claim / daemon 贯通回归证明。最后补齐 UI owner 的最终 PR / SHA 和本地 production build 证据，才满足 Epic 的完整关闭条件。
