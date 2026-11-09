# 正式 CC×3 / CX×3 runner：只读准备记录

状态：未激活计划、没有新测试、没有模型或生产请求、没有 scope 创建。固定阅读对象为 driver/adapter **bcb7ea695a07e479ef2c6fd52332a6f098d1f1fb**、evidence **f2e59c778a6e04df30a4ad633aa7c6f7265caf86** 下 formal-renderer，以及 scope-H helper **5958dea38437de20512bbbdf60b940ccc83f00ff**。后续 4c2 仅改 task-secrets 测试 fixture，不改变本结论涉及的产品文件。以下顺序是 root 已选择的未来安排，不表示已执行。

## 正式路径接线

现有模板使用 `--runs 6 --harness both --mode acceptance --strategy derived --runtime-evidence required --official-timing enabled --max-startup-ms 5000 --timeout-ms 240000`，固定既有 Bot `fdeea45f-8cb2-450a-96a4-d9a682f71482`；实际交替 CC/CX 各三次。继续使用普通 SMOKE shared-team 会话、Coordinator、Task、cloud dispatch 和现有临时 Profiles，无 candidate device/agent/callback。模型保持 `claude-haiku-5-5` / `gpt-6-luna`。

bcb Codex 原生 bash 仅 exitCode===0、apply_patch 仅 status==='completed' 计成功；MCP explicit failed 由 f044 adapter 映射 tool-output-error。独立成功工具之后才可计 marker 回复；submit-only 不计执行工具。driver 成功集合控制 sample status，正式附件仍要求 execution_proved_awaiting_server_timing，审计 toolCalls.outcome 不能独自授予通过。必须实际发布包含 f044 的 worker，不能只更新 driver。

保持原计时公式：数据库 agent_start receipt 相对 dispatch_run_entry 的时长，加同 daemon 中较晚官方 ACK 的非负 monotonic offset，要求 <=5000 ms。39 个 server stages 仍为 8 dispatch + 17 thread + 8 claim + 6 spans，daemon 初始化另按原规则验证。14 次版本观察、失败例 closing pin、identity 与清理门槛不变。

## 16 个未决字段及来源

| # | 字段 | 必须绑定的实际来源 |
| --- | --- | --- |
| 1 | ACCEPTANCE_SOURCE_COMMIT | 最终选择并复核的 driver Git commit；bcb 是本次读取基准，不能代替未来 APP/runtime 事实 |
| 2 | ACCEPTANCE_SOURCE_TREE | 对应完整 tree；bcb 为 6748ac1196b68773b198ae5a690db4122a287fcb |
| 3 | EXPECTED_APP_COMMIT | fresh scope 后实际所选 Web 的 READY DPL source 和 public build |
| 4 | EXPECTED_WORKER_SHA | 实际 R7 accepted/public release 的 worker fingerprint |
| 5 | EXPECTED_WORKER_SOURCE | 同一 release source，同时用于 upstream sourceCommit |
| 6 | EXPECTED_TEMPLATE_DESKTOP | 同一实际公开 release 的 Desktop ID |
| 7 | EXPECTED_TEMPLATE_CLAUDE | 同一实际公开 release 的 Claude ID |
| 8 | EXPECTED_TEMPLATE_CODEX | 同一实际公开 release 的 Codex ID |
| 9 | EXPECTED_DIAGNOSTIC_ENV_ID | fresh scope 创建与精确 readback 原件 |
| 10 | EXPECTED_DIAGNOSTIC_VALUE_SHA256 | 上述完整实际 value 的 SHA256 |
| 11 | EXPECTED_DIAGNOSTIC_EXPIRES_AT | 上述创建时固定 expiresAt，不延长旧 TTL |
| 12 | DIAGNOSTIC_HELPER_COMMIT | 实际审阅并选用的 cleanup helper commit |
| 13 | DIAGNOSTIC_HELPER_SHA256 | 该 commit 的完整 helper bytes |
| 14 | executionBranch | root 本轮唯一新执行分支及实际 execution head |
| 15 | upstreamRelease.runId | 实际 R7 exact run，须满足既有 push/main/path 合同 |
| 16 | upstreamRelease.runAttempt | 同一 run 的实际 attempt，不混用重跑证明 |

它们是 13 个动态 env pin 加 branch/runId/attempt，并非全部来自 R7/Web。既有固定配置保持：EXPECTED_DEPLOYMENT_ID=RESOLVE_ONCE_FROM_PRODUCTION_ALIAS，在 Web 锁中解析一次，后续只比较；Bot ID 保持上文固定值。

## root 选择的启动与收尾顺序

1. **先 R7 七 jobs 全部 success**：test、check、validate / build、await-web、subscriptions、publish / deploy、cleanup，同一 run/attempt/source，真实双订阅和公开 release 已绑定。
2. **随后创建 fresh scope**：既有 SMOKE/shared-team、固定 idle Bot；正常 restore workspace/sign-out 成功后精确写入并读回 env。Scope helper 不创建模型任务或 VM。
3. **再由实际所选同 source Web 的 vercel pull 捕获该 scope，直到 READY/public version 确认。** 不把 R7 之前已有 READY DPL 视作捕获了后来 scope。
4. 填写并审阅 16 项，确认实际入口 scope 余量至少 45 分钟，再启动正式 job。Job 仍 40 分钟，scope 原 120 分钟 TTL 不延长；不在 SMOKE/Web 锁内等待尚未完成的发布。
5. 正式 job 做 metadata/source/helper/time guard 后读既有身份的秘密，核实际 tuple、解析一次 DPL，再进行普通 CC/CX 六 Task。每例 closing pin 后只清自己的 producer/run/machine/issue；整批清临时 Profiles、停止 Bot、恢复 workspace、sign out。
6. 收集同批真实计时并严格判定，always cleanup 精确删除本轮 scope ID/value，核 ID 404 与 key 缺席，上传脱敏回执。配置删除不撤销活动 DPL 中已有环境；原 expiresAt 仍生效。执行分支关闭仍由 root 另行完成，模板没有自动删该 ref。

## 三条具体接线约束

**队列约束。** 正式模板自 job 开始持有 web-deploy-production；R7 publish / deploy 也需要该锁，而模板 upstream wait 只有 300 秒。提前入场会阻塞自己等待的发布并超时。必须先等 R7 七 jobs 完整 success；changed=false 的 SKIP 或 workflow_dispatch 不符合现有严格 upstream 合同。

**scope 捕获约束。** Project env readback + READY/source/public build 不证明活动 DPL 捕获了该 env。bcb Web 捕获点是 web-deploy.yml 的 vercel pull --environment=production。若先 READY 再创建 scope，14 次 project pin 仍可能通过，实际样本才因 App process.env 无诊断窗口而缺 runtime/39 stages。采用上面的 root 顺序消除此风险。

**5958 绑定约束。** 旧 helper CLI 固定 e33 source/tree、旧 branch/GO/sole parent/上一条 receipt，不能只换外层 checkout 就当作新 prepare。正式 runner 仅 import removeOwnedWindow，用 helper 导出的 SOURCE/TREE 加实际 ID/value hash 构造目标，不调用旧 CLI main guards；helper 与 driver SHA 不同本身不会让 cleanup 失败。实际 helper、fresh receipt 和 Web 捕获仍须分别绑定，不能回填旧历史 scope 三值。

## 固定源码链接

- [bcb driver](https://github.com/alexj11324/Mikka/blob/bcb7ea695a07e479ef2c6fd52332a6f098d1f1fb/scripts/acceptance/cloud-startup.mjs)
- [bcb Codex adapter](https://github.com/alexj11324/Mikka/blob/bcb7ea695a07e479ef2c6fd52332a6f098d1f1fb/packages/daemon/src/adapters/codex.ts)
- [bcb Web workflow](https://github.com/alexj11324/Mikka/blob/bcb7ea695a07e479ef2c6fd52332a6f098d1f1fb/.github/workflows/web-deploy.yml)
- [formal template](https://github.com/alexj11324/Mikka/blob/f2e59c778a6e04df30a4ad633aa7c6f7265caf86/evidence/1505-startup-timing-20261108/formal-renderer/workflow.template.yml.in)
- [formal fields](https://github.com/alexj11324/Mikka/blob/f2e59c778a6e04df30a4ad633aa7c6f7265caf86/evidence/1505-startup-timing-20261108/formal-renderer/fields.json)
- [scope-H 5958](https://github.com/alexj11324/Mikka/blob/5958dea38437de20512bbbdf60b940ccc83f00ff/scripts/ops/issue1505-diagnostic-window.mjs)

以上均是源码阅读结论，不是未来部署、scope、订阅、性能、完整 CI 或资源清理成功的证明。
