# #1505 精确诊断窗口清理：未激活预制包

本包补足正式验收在 `source_ready` 或 `platform_token` 之前失败、原 always cleanup 因前置条件不成立而跳过时的恢复入口。当前只是一份本地、未填值的清理载体；没有 Git commit/ref、OIDC、平台调用、scope、Web refresh、账号登录、Task、VM、模型或数据库操作。

## 可审文件与固定来源

- `.github/workflows/issue1505-diagnostic-cleanup-r7.yml.in`：唯一 workflow 草案，扩展名为 `.yml.in`，job `if: false`。
- `scripts/ops/issue1505-diagnostic-cleanup-r7.mjs`：5958dea38437de20512bbbdf60b940ccc83f00ff 的 `scripts/ops/issue1505-diagnostic-window.mjs` 完整原字节；27063 bytes；SHA256 `46d8b905518cf480fecdf0a3bce1a3863f4e79c92609b1cd3ec9d4231820898c`；Git blob `e9f07af8ec87eb83b3eb46c046731390ba97c1d9`。
- `bindings.unfilled.json`：全部 fresh 输入为 null，仅 version=1。workflow 内嵌的是同一份输入；该文件不是最终仓库新增路径。
- `source-provenance.json`：源 commit、路径、hash、旧 schema 常量与预定两路径。
- `provenance/original-pure-call.txt`：29218a0ff3f8dd458963eed3956666572b564309 的 formal-renderer/workflow.template.yml.in 原 cleanup 纯调用段。
- `syntax/*.mjs`：仅用于 `node --check` 的 workflow inline JS 提取件，不作为额外仓库文件发布。

实际发布时只能是 actual main 的正常单父子提交，相对该 main 恰好新增两条路径：

1. `.github/workflows/issue1505-diagnostic-cleanup-r7.yml`
2. `scripts/ops/issue1505-diagnostic-cleanup-r7.mjs`

本包没有创建该提交或分支；main/source/tree 都尚未绑定。若任一路径在届时 main 已存在，应停止并重新审阅，不能覆盖。包内其余文件是本地复核材料，不属于这两路径产品增量。

## 清理语义与原实现守恒

只通过模块导入调用导出的 `removeOwnedWindow`，不以 helper 为 Node CLI 入口，不调用 `main`、prepare 或 renew。完整 helper 虽保留旧流程定义，导入不会进入其 `import.meta.url === process.argv[1]` CLI 分支。

原函数固定 project `prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`、team `team_C7lwxVVvnUicFli6112mvxpv`、key `MIKKA_CLOUD_DIAGNOSTIC_WINDOW`。它先列举精确 key/ID，要求同一 production 范围、无 branch/custom environment，读取实际值并核完整 SHA256，然后仅 DELETE 该 ID；最后要求 ID 404 且列表无同 key 或 ID。若目标已不存在，它只验证缺席。不会按 key 批量删、不会创建新 scope。

纯调用沿用原 formal 段，只变更 helper 导入路径，并传入 `fetchImpl` 守卫：OIDC 后先复核 main/time，真正的 DELETE 请求前再检查一次相同 main/time；平台请求仍限定 HTTPS `api.vercel.com`、禁止重定向，沿用原每请求30秒上限，并以 hard end 剩余时间进一步收紧 abort signal。未改 helper 本体、精确值检查、删除路径或成功标准。

旧 helper 的 `SOURCE=e33e…`、`TREE=b2e36…` 是 `removeOwnedWindow` 接收对象的原 schema 绑定，**不是本次 main 或新 scope 创建凭据**。workflow 构造的 expected 对象只是 root 已审 fresh scope receipt 的 ID/hash/expiry 投影，不冒充新创建结果。真正的 fresh receipt 必须由 root 在激活前独立核对并保存；`freshScopeReceiptSha256` 只记录该原件的摘要，不替代核查。工作流不会下载或校验这份原 receipt artifact；它是 root 激活前审阅后的来源锚，不能称为现场 artifact 验证。

删除 project environment 配置不撤回已构建部署中的诊断值：输出始终明确 `activeDeploymentRevoked:false`，原 expiry 仍是这类部署的有效期边界。本包不请求 Web refresh。

## 入口与时间守卫

固定 push branch：`ops/1505-diagnostic-cleanup-r7-20261109`。
固定 GO：`root-reviewed-1505-diagnostic-cleanup-r7-20261109-v1`，当前输入为 null。

OIDC 前检查 repository、push event、exact ref/workflow ref、attempt=1、HEAD=GITHUB_SHA、唯一 parent=绑定的 actual main、parent tree、两条 A 类型新增路径、100644 mode、tracked clean、helper Git blob 与 SHA256。再用仅具 contents:read 的 GitHub token GET main，要求仍等于绑定的 main。

时间均使用 UTC 毫秒 ISO 字符串：`startAt` 是允许入场起点，`latestEntryAt` 是最晚入场时间，`hardEndAt` 是原协调段硬截止。必须满足 start≤latestEntry、latestEntry+10min≤hardEnd；实际入场还要求 now≤latestEntry 且 now+10min≤hardEnd。实际入场时点写入 preflight receipt。OIDC 后、DELETE 前及每个平台请求前继续核 hard end 与距入场不足10min。队列等待不能延长入场或硬截止。

保留 workflow 层 `production-smoke-owner-acceptance` 和 job 层 `web-deploy-production` 两个原队列；两者均 cancel=false、queue=max。job timeout=10min。没有新轮询或重试。GitHub main GET 是有界即时核对，不宣称与后续平台 DELETE 构成跨系统原子 CAS；root 必须保持原协调与唯一 writer 约束。

## 唯一凭据边界

原 pin 的 Infisical action、identity `2cf9fa19-b9db-4c08-8ca0-b31859f2cbac`、project `89850d6a-f020-4936-863e-df77380dfe40`、audience `mikka-infisical`、env `prod`；只读取 `/platform` 下 `VERCEL_TEAM_TOKEN`，include-imports=false。不请求 SMOKE、DATABASE、MIKKA_DATABASE、E2B、Owner 或模型凭据；无需安装仓库依赖。权限为 contents:read / id-token:write。

新分支实际 OIDC subject 是否被既有服务信任，尚无执行证明；本离线包不声称已授权成功。若 OIDC 失败则 DELETE 不会执行。不能为此扩大 identity 权限或绕开原信任条件。

## 报告与失败恢复

所有自写错误输出都使用闭式代码，不输出异常 message/cause、响应正文、环境变量或 token。preflight 与 cleanup JSON 以0600写入，原结果只会被同一次调用的实际进展更新。调用前写 cleanup_started；发送 DELETE 前写 exact_delete_requested/unknown；返回后记录 response_success 或 response_error；最终仍必须通过原404与key缺席检查才能 passed。DELETE 响应不明不能盲目重试或声称未删除。

always 步只在实际 cleanup 报告不存在时补 not_attempted，不覆盖已有失败、进度或成功结果。随后上传两个精确安全报告，保留7天。runner 强制终止、磁盘或 artifact 服务失败可能导致报告上传不可得；不能以 always 声称必然持久化成功，root 必须核实际 artifact/报告及缺席结果再关闭入口。

## root 激活时的最小顺序（尚未执行）

1. 在实际允许的协调空档，核 fresh main/tree、fresh scope receipt 的 project/team/key/ID/valueSHA/expiry及其原件摘要，确认新 operator 两路径尚不存在。
2. 填完整 bindings；明确 start/latestEntry/hardEnd，保留原硬截止，不重置窗口。只在已审 enable diff 中填 GO、将 job false 改为受审启用状态，并把模板渲染为 `.yml`。
3. 核实际 main 的全部既有 push workflow 不因该 branch 触发额外业务；核新分支 OIDC subject 的既有信任范围。创建 parent=[actualmain] 的正常两路径子提交，独立回读 tree/blob/parent；由 root 使用正常 expected-head/CAS 发布唯一 ref。
4. 只运行 attempt1；若守卫或 OIDC 拒绝，保留闭式失败，不取消/重跑/放宽。DELETE 结果不明先核原报告，由 root 决定精确后续恢复。
5. 核 actual cleanup passed、ID404/keyAbsent，然后按原正常后继/CAS停用本入口并保存数据回执。不会创建或重建 formal ref，不产生正式样本。

## 本次验证范围

仅执行固定 Git 对象只读提取、字节/hash 比较、4个 `node --check`、Python AST 解析、YAML解析与静态结构核对。没有运行导出函数、workflow、业务测试、安装器、VM、模型、SQL、生产 API 或远端写操作。根 checkout 保持4c2efa6e9c57af88168c2d57039982ae29a9b54e且 clean。正式新样本仍0；此包不是清理成功或可激活的运行回执。
