# #1211 固定一小时任务的只读观察

本分支的脚本准备测量和收集证据。它们不提交生产 prompt、不调用模型、不读取浏览器 cookie，也不创建任务或修改生产数据。任务须通过正常产品入口，使用已授权的测试账号启动。

## 固定工作定义

三条路径执行相同的回归审计：依路径顺序审阅固定提交的 Factory、Coordinator、Cloud-computer 源码及测试，运行适用的离线/本任务本机隔离测试，持续产生具体审阅记录，最后交付 JSON 产物。不得靠 sleep、重复工作或任务结束后的空闲补足时间；提前完成或遇到阻断就如实结束，该小时不能作为完整验收。

| 固定项 | 值 |
| --- | --- |
| 源提交 | `2a0e398762d35a94ac673d04ce3683d9de1568d7` |
| 文件范围 | `lib/factory`、`lib/coordinator`、`lib/cloud-computer` 下的 `.ts` / `.mjs` |
| 文件数 | 297 |
| 路径清单 SHA-256 | `490d52e0b13f43223a82f715688a3257bb091592bef9748d8130497dce80c8d1` |
| 核心工作定义 SHA-256 | `5f28e01fc001cc242359cc2a2bdf1d8db9923b5dd9e3c1c298767c76d6c00eee` |
| 工作定义版本 / 并发数 / 时长 | 2 / 1 / 对齐 UTC 的完整一小时 |

核心工作定义 digest 不包含模型路径或窗口时间。同一路径的 before/after 必须保持工作定义、模型、harness、界面可见状态、测试账号/资源绑定和并发数一致。三路径分别记录，不能互相代替。

| `EGRESS_PATH` | 模型 | harness | 凭证类型 | 官方订阅 route |
| --- | --- | --- | --- | --- |
| `api_key_flash` | `deepseek-flash` | `claude_code` | `api_key` | 无 |
| `claude_subscription` | `claude-haiku-5-5` | `claude_code` | `subscription` | `claude_code_cli` |
| `codex_subscription` | `gpt-6-luna` | `codex` | `subscription` | `codex_cli` |

API 路径固定使用 Claude Code harness，与本次已有 API 案例一致。不能因配额或重试换模型、凭证路径或 harness。

## 使用

需要 Node 24、Git 和包含固定源提交的 Mikka checkout。浅克隆缺少旧对象时，在测量专用 checkout 获取该公开提交；不要把当前 main 文件清单当作固定源。下列变量都是非秘密测量元数据。

```bash
export MIKKA_REPO_PATH=/path/to/measurement-checkout
export EGRESS_SOURCE_SHA=2a0e398762d35a94ac673d04ce3683d9de1568d7
export EGRESS_PATH=api_key_flash
export EGRESS_WINDOW_START=YYYY-MM-DDTHH:00:00.000Z
node scripts/ops/mikka-egress-hour.mjs plan
```

`plan` 输出工作定义、digest、期望路径和具体 prompt，本身不启动任务。API prompt 提交前仍须在 checkout 执行 `node scripts/assert-test-model.mjs deepseek-flash`。

确认 Web deploy 完成、生产 `/mikka/api/version` 的 build 等于合并提交并记录 deployment ID，在窗口开始前运行版本观察：

```bash
export EGRESS_EXPECTED_BUILD='<40-character-merge-SHA>'
export EGRESS_DEPLOYMENT_ID='<dpl_id>'
export EGRESS_REPORT_PATH=/tmp/mikka-egress-hour-versions.json
node scripts/ops/mikka-egress-hour.mjs observe
```

`observe` 每分钟仅 GET 一次公开 version，共 61 个检查点；版本变化、HTTP 失败或超过 15 秒采样延迟都会失败。它不能证明两次采样之间未短暂切换部署，所以窗口内仍须冻结应用/网关部署并复查 provider 时间线。

记录正常入口产生的真实 run/issue UUID，生成固定 Neon 只读查询：

```bash
export EGRESS_RUN_ID='<run-uuid>'
export EGRESS_ISSUE_ID='<issue-uuid>'
node scripts/ops/mikka-egress-hour.mjs neon-sql
```

`neon-sql` 仅生成一个 SELECT，固定 project `autumn-fire-21908520`、branch `br-autumn-rain-b5leflom`、database `orvilo_mvp`。用已有只读连接，在 0、5、10……60 分钟分别执行，保存返回行组成 JSON 数组；每点容差 ±30 秒。只读状态、时间、模型/harness/凭证类型、最后 chunk 序号/时间和并发计数，不读取 prompt、chunk 内容、key ID、binding ID 或秘密值。

```bash
export EGRESS_NEON_SAMPLES_PATH=/tmp/mikka-egress-neon-samples.json
node scripts/ops/mikka-egress-hour.mjs check-neon
```

`check-neon` 验证精确任务/issue、明确模型选择、冻结模型与凭证模型一致、官方订阅 route、无双凭证、项目没有另一个 running run、没有其他 run 的开始/结束时间与窗口相交，以及任务覆盖完整窗口。最后一次采样必须发生在窗口结束后，不能用结束前 30 秒的 running 快照代替。序号停滞保留人工复核标记。全部采样通过也只输出 `samples_observed_pending_provider_and_artifact_review`。

## 真实窗口的判定

必须同时核对以下证据，不能仅凭 running 状态或模型自述时间宣称通过：

1. 冻结 build/deployment、UTC from/to、路径、task digest、run/issue、并发数和版本/进度采样。其他 run 与窗口重叠（包括两个五分钟采样点之间完成的短任务）、版本变化、模型或凭证切换都会破坏单任务对照。
2. 实际运行记录与正常产物 `mikka-egress-audit.json`：逐条复核具体审阅、真实命令/退出结果、文件 hash、时间和剩余工作，确认整个窗口确有实际工作。
3. `acceptance-egress-hour.mjs` 对同一固定小时的 Vercel route/httpStatus 调用数、deployment ID 与 Neon `public_network_transfer_bytes` 精确小时桶。

Neon 可能延迟返回。缺少完整桶时记录为不足，不能补成零或使用相邻小时。collector 的 reportedThrough 是请求范围内已返回桶的最大结束时间，不是独立的最终计费回执。Neon project 包含所有分支流量。保留生产 cron/smoke，记录其常规背景流量，再单独测真实空闲窗口。历史 connectivity smoke 不计入 before/after。两份脚本均不改 PostHog 阈值。

## 验证及 workflow 范围

2026-11-04，在既有 Large Vercel Sandbox（8 vCPU / 16 GiB）中，Node `v24.22.1` 执行 `node --test mikka-egress-hour.test.mjs`：**6/6 通过、0 skipped、exit 0**，约 0.9 秒。使用临时合成 Git repo/JSON 样本，没有生产 HTTP、SQL 或模型请求。这是工具合同验证，不是生产任务验收。真实公开源另行只读核对得到上述 297 文件和两个 digest。

本次只新增两份 `scripts/ops/mikka-egress-hour*.mjs` 和本文档。已核对该分支全部 workflow：这三条路径不命中 acceptance collector 的四项 path filter；其他 push workflow 仅针对 main 或其他明确分支，生产 smoke 使用 schedule/deployment_status/workflow_dispatch。因此本次提交不触发 collector、生产部署或付费模型 driver；不修改 workflow、OIDC 身份或权限。

