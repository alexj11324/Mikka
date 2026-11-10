# CP58：Native early-live 首轮实际验证失败

本检查点完整保留候选 **G 的第一次实际验证 FAIL**、运行来源、原始输出、单次入口关闭及 owned PostgreSQL 清理结果。它不是 Native 性能验收通过，也不是生产调用链验收。

## 固定来源与运行

| 项目 | 固定值 |
| --- | --- |
| G source | ff385bfd91edcd40c3b3ee398b4b93098e5becbb |
| G tree | 7b1f2dcafc18918611938cba3716a4237d8a1f64 |
| G parent M | 9238b7092a39fce7edde2e488aef516c0b544677 |
| M tree | 03712f2c1ca03ee45e61e124bd430fc9d1a377c9 |
| M parents | H 5f3598029033b83ee72c88ea6c49955205eecab2 + main ab2d00a43a79d35380b4d2db9014a3792fea63ca |
| 实际运行 | run 42766089161 / attempt 1 / job 129662811912 |
| 本次入口 source | 063cf037560c750d87aa93818bd5b58bdfc78d69 |
| Node / pnpm | v24.22.1 / 10.34.3 |
| 最终结论 | **FAIL**；prepare、依赖安装、PG start、always cleanup 和上传完成 |

G 在 M 上共有 20 个源文件差异，其中 5 个是新增文件。[source-G](source-G) 保存这 20 个文件的精确内容；[source-M](source-M) 保存其 15 个既有基底。归档文件增加 .txt 后缀，内容和 Git blob 不变，避免归档测试被普通测试发现器误执行。[完整差异](source/G-from-M-diff.json) 收录 20 个 Git patch；所有基底也与 M 的完整树独立核对。

[Root 来源整合证明](source/source-integration.json)、[前端 manifest](source/frontend-manifest.json)、[后端 manifest](source/backend-manifest.json) 与 [原始控制器](control/driver.original.mjs.txt) 绑定本次来源。Native 实际校验记录了 28 个 sourceProof，运行前后均保持 G 的 HEAD、tree 及绑定文件。静态审查是执行前的记录，不能覆盖本次实际失败。

## 实际结果

| 命令组 | 实际结果 | 必须保留的边界 |
| --- | --- | --- |
| Live routing TS | **100 tests / 98 pass / 2 fail** | 两个新 freshness 反例期望 2 次业务读取，实际 1 次。 |
| Renderer bootstrap | **54 / 47 / 7** | 首个实际错误为 TypeError: useSWR is not a function；后续 App 断言的 undefined 值保留在完整输出中。 |
| Startup 与 template validators | **39 / 38 / 1** | 38 个 template 测试通过；cloud-startup 文件因 extensionless lib/secrets/mask 模块装载失败。预期的 88 个 cloud-startup case 未注册、未执行，不能称 126 个已运行。 |
| Cache scope PG | **3 / 2 / 1** | 原有 2 个测试通过；新增父测试在 fixture setup 被真实数据库 23514 拒绝。其 12 个新增子测试未开始，不能称 15 个已验证。 |
| Root types | **FAIL，exit 2** | LiveChannelRegistry 与旧 LiveChannels 参数类型不匹配；测试空数组断言造成 never[] narrowing。 |
| Frontend types | **FAIL，exit 2** | 同一 registry 类型不匹配。 |
| Desktop renderer types | **FAIL，pnpm exit 1** | 原输出保留子进程 tsc exit 2 和同一类型问题。 |
| Root changed-source oxlint | PASS | 独立命令 exit 0。 |
| Desktop source oxlint | PASS | 使用 desktop 自己的配置，exit 0。 |
| UI/runtime policy | PASS | 现有 scripts/lint-ui.mjs，exit 0。 |
| Migration bootstrap | **2 / 2 / 0** | 真实新建隔离 PG 上执行。 |
| E2E setup | PASS | 原命令 exit 0；不是新增测试数量。 |
| Environment bind | PASS | 原命令 exit 0，目标绑定隔离数据库。 |

所有已报告的 TAP 汇总均为 zero skipped / todo / cancelled。这不表示尚未注册的测试已执行。执行前的 100 / 54 / 126 和 PG 15 只是源代码计数门禁；失败后没有下调这些预期来制造通过。

完整结果与机械复算见 [actual/mechanical-verification.json](actual/mechanical-verification.json)。源码和清理验证成功不会把测试、装载或类型错误改成成功。

## 原件和保存规则

唯一原件读取者为 /root/native_pending_final。本次归档只读取已冻结 Git 副本，没有再次读取 Actions 日志或 artifact 原件，没有启动 compute。

- [原始流索引](actual/original-stream-index.json) 列出 **13 个命令、26 份 stdout/stderr，共 94,767 B**，逐份包含长度、SHA256 和 Git blob；13 份 stderr 都为空文件。
- [完整 job log response](actual/job-log-response.original.json) 和 [完整 decoded job log](actual/job.original.log) 在首次解析前已冻结；日志为 542,259 B。
- [actual/streams](actual/streams) 保留全部 26 份原始流。没有删掉失败输出、截取绿色片段或补写运行结果。
- [actual/emitted](actual/emitted) 的 CONTROL、DATABASE_STARTED、VERDICT、CLEANUP 是日志里发出的**精确 JSON payload**；不宣称它们与未下载 ZIP 内的 pretty JSON member 字节一致。
- [Artifact metadata](actual/artifact-metadata-only.original.json) 仅保留元数据：artifact 13739543979，37,224 B；原 ZIP **未下载**。
- [终态 jobs metadata](actual/jobs-terminal.original.json) 保留原读取响应。此归档没有发起新的 Actions 原件访问。

[index.safe.json](index.safe.json) 对所有 payload 和本 README 记录精确 Git SHA、UTF-8 字节数、SHA256、来源类型和路径。index 排除自身哈希以避免自引用；完整新增 leaf 清单与候选 tree 在提交交付证明中给出。

## Owned 资源清理与入口关闭

原 cleanup 从 **2026-11-10 06:07:42.508 UTC** 到 **06:07:44.170 UTC** 完成：

- 精确 owned container 已停止并删除。
- 实际挂载的匿名 volume 已删除。
- 精确 owned empty network 已删除。
- cleanup errors=[]；完整资源 ID、名称和回执保留在 [CLEANUP.original.json](actual/emitted/CLEANUP.original.json)。
- PG 实际版本为 170011，隔离数据库 mikka_e2e，loopback only；没有生产数据库目标。

G1 的单次入口按正常提交关闭为 **6d7f36ea3c6b918f613cf22e848ed52d413d2bd6**，其 parent 是本次 active commit。关闭 manifest enabled=false，workflow job 条件为 false。关闭运行 **42766253819** / job **129663381273** 为 **SKIP**，runner_name=null、steps=[]。见 [历史关闭记录](control/closure.json) 和 [独立来源/关闭核验](reviews/source-and-closure-binding.json)。

这里记录的是 G1 的实际关闭事实；后续单独授权的 G2 可以有自己的入口，不能用本检查点推断 ops 分支未来不再变化。

## 待验证 G2 补充

[pending-G2](pending-G2) 仅收录基于真实错误的四文件修复、精确 diff 和静态复核。G2 正常继承 G，候选 commit 为 **0b3b0f69b901b46e9d25da7e619e04f2c09c4c9e**，tree 为 **a9e6c067fbceb7c49143b9f5d1110971c2e535a1**。**本检查点未包含 G2 实际验证结果，不能称它已通过。**

1. App 测试按 ESM import 条件加载 SWR，保留原行为断言。
2. 共享 hook 的三处类型注解改用现有结构 registry 合同，执行行为不变。
3. 四个 freshness 反例推进原有 100 ms debounce，并明确断言 refresh 被调用，再保留读取次数 **1 / 2 / 2 / 1**。此前两个 positive case 也未实际触发 refresh，不能把它们当有效 freshness 通过。
4. PG fixture 尊重已有个人 workspace membership/kind 数据库约束，将非法写入验证为明确拒绝反例；不关闭约束、不改产品或 schema。

生产 scheduleFlush、retry、readFresh/proof 条件、snapshot 白名单、Native fixture、完整窗口、五对样本及预算均未因本次失败改变。G2 的控制器或未来运行不属于这份首轮失败归档。

## #1512 的验收状态

本检查点时正式 head 仍为 **H 5f3598029033b83ee72c88ea6c49955205eecab2**。原完整登录 SQL 为 **Native 441 / Web 331，FAIL**；这次 Linux 单元/PG/type/lint 验证没有执行 packaged Native 接受窗口，也没有执行任何生产模型调用链。

**生产验收仍为 0/2，issue 保持 open。** 不以静态审查、测试 fixture 修复、资源清理成功或孤立命令 PASS 替代最终验收。Root 在 issue #1512 的进度记录 6760746238 已如实报告本次 FAIL。
