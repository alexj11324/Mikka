# #2984 仓库迁移后的 SDLC 差异核查

本轮完成只读核查，未修改源码、未触发或重跑 CI、未进行发布或模型调用。当前普通 PR / 通用测试设施里已确认的旧身份故障，均已由 #2994、#3001 或本专项另行分派的 runtime SDLC-008 覆盖。另发现一个尚无同根在途补丁的 **营销站公开来源准入遗漏**；它位于原发布 Owner 的入口边界，已提交给主执行代理判定归属，不能冒称整个迁移链路已完成。

## 固定来源和分母

- 公共仓库真实身份：`aspectly-labs/Mikka`，repository ID `1427517699`，owner ID `359279274`。原 Alex actor ID `183887963` 仍是个人执行身份，不应随仓库所有者迁移而替换。
- 本轮固定主干 `6fe25cf9413d4078ce350a97e284c33f1efa9de7`，tree `d28479a64b1bb54c13f44c745834cdd0cadda73e`。00:09:23 UTC 再次读取仍为该版本。
- **54 个工作流全部列入分类**；**50 个开放 PR 的全部 2,570 条变更文件记录**均完成分页核查。#2839 为 10 页，#2821 为 2 页，#1859 为 3 页，#1853 为 2 页，其余为 1 页。末次刷新只有本专项 #2992 head 变化，已补录 `871a5f59…` 对应文件清单。
- 固定事件窗口 `2026-11-20 23:27:27 UTC` 至 `2026-11-21 00:09:00 UTC`，精确主干共 **139 个 run**，两页 100 + 39，无重复、无异源 head。其中 8 个为 main push；这不是全历史失败率，也不是完整发布验收分母。

| 工作流分类 | 数量 | 判定 |
| --- | ---: | --- |
| 无正在生效的旧身份准入条件 | 17 | 描述文字、历史链接、合成 fixture 不计故障 |
| 已使用官方有限身份 profiles | 14 | 保留 actor、精确来源和发布 Owner |
| 原 Owner #2994 已实现修复 | 6 | 不复制其未合分支 |
| runtime SDLC-008 已另行分派 | 3 | 不重复审改三 consumer 及共享 reader |
| 原生产或固定旧版本验收范围 | 13 | 按原 Issue / 窗口处理，不扩大授权 |
| 新发现的营销来源准入遗漏 | 1 | 原发布边界，交主执行代理归属判定 |

## 真实故障与已有修复

### Workspace governance：错误在 HTTP 之前发生，已有实际 after

[44836931526/1，job 136635588790](https://github.com/aspectly-labs/Mikka/actions/runs/44836931526/job/136635588790) 于 `23:28:22.6854508 UTC` 失败。原 `.github/workflows/workspace-governance-acceptance.yml:82` 断言 `GITHUB_REPOSITORY === alexj11324/Mikka`，实际值为 `aspectly-labs/Mikka`，尚未执行迁移和 HTTP。

[#2994](https://github.com/aspectly-labs/Mikka/pull/2994) 精确 head `40571ce6…` 的 blob `690be94e…` 复用既有 `actionsMikkaRepository`，同时核对不可变仓库 ID 与一致的 owner/name。其 [run 44839882377/1，job 136647099148](https://github.com/aspectly-labs/Mikka/actions/runs/44839882377/job/136647099148) 已 success；原第 8 步真实 HTTP Item 11 在 `00:01:56–00:02:54 UTC` 执行成功，前面原迁移及精确 checkout 检查也均成功。这里是 N=1 before 与一个精确候选 head 的 N=1 after，不能据此声称整轮 CI 或生产发布通过。

[#3001](https://github.com/aspectly-labs/Mikka/pull/3001) 当前 `d44714e5…` 在同文件将旧 literal 改为 canonical literal，blob `64e5d1e6…`；其 Workspace job `136646598262` 亦已 success。这是同根重叠，需由原 Owner 在集成时处理，不能再开第三份实现。

### Cloudflare 来源资格：本地 Git fixture 受到环境影响

[44836932644/1，job 136635594456](https://github.com/aspectly-labs/Mikka/actions/runs/44836932644/job/136635594456) 的 `scripts/cloudflare-native-oci.test.mjs:60` 失败为 `CF_OCI_STAGE_OVERLAY_MAIN_FETCH_FAILED`。本地 fixture 把旧私仓 URL 重写至临时 Git 源，而实际 verifier 继承了运行环境中的 owner 选择。这是单元 fixture 隔离问题，不能说成真实私仓构建或凭据失效。

#2994 `40571ce6…` 的 blob `66259e14…` 对两次原 verifier 调用都显式传入 fixture 环境；#3001 的 `444219cc…` 处理同根。原真实发布校验未减弱，历史 fixture 字节也未被改写为新的生产回执。

### Device / Minute：共享 selector 的旧名字拒绝主干

[Minute 44836930788/1，job 136635586965](https://github.com/aspectly-labs/Mikka/actions/runs/44836930788/job/136635586965) 和 [Device 44836931255/1，job 136635587790](https://github.com/aspectly-labs/Mikka/actions/runs/44836931255/job/136635587790) 分别在 `23:28:46.9947526`、`23:29:53.2155981 UTC` 报 `reviewed_main_workflow_required`。两者共同使用 `scripts/device-gateway/select-release.mjs:23` 的旧名字条件。#2994 已在 blob `1147f810…` 复用既有官方身份 helper，并修改对应部署入口；该故障不得再由本专项重复实现。实际 deploy jobs 被跳过，不能算发布成功。

### Draft 合同漂移及正确的发布拒绝

#3001 当前 [44840080079/1，Core job 136646597669](https://github.com/aspectly-labs/Mikka/actions/runs/44840080079/job/136646597669) 的三个实际失败仍是 `ci-docs-only.test.mjs:224`、`ci/optimization.test.mjs:88`、`ci/select.test.mjs:126`。这是 #2998 接受后的旧合同，已经由 #2994 处理，不能归为 Eve 或仓库迁移的产品回归。

#2994 同一 head 的 Source `136647098338` 已 success（00:11:12），Core `136647098396` 已 success（00:11:57），但整轮还有 queued / in_progress jobs，**并未取得整体通过**。

主干 [Publish daemon 44836930995/1，job 136635587082](https://github.com/aspectly-labs/Mikka/actions/runs/44836930995/job/136635587082) 失败是 `releaseCheckFailed:ui-policy.yml`。它已接纳 canonical 主干，随后正确拒绝失败的精确版本 CI；这是必要安全门槛，不能为加速而消除。

## 新发现：营销站来源准入仍只接受旧公开仓库

当前 `marketing-build.yml` 以不可变 repository ID 和原 Alex actor 允许 manual main 进入，但首个无凭据步骤调用 `scripts/cloudflare-marketing-ci.mjs` 的原 `sourceContext`，其第 44、46、51 行仍固定旧公开仓库名、旧 owner ID 和旧 workflow ref；`runMarketingCi` 第 86 行还固定旧 Git origin。

已在精确 6fe、Node 24.22.3 执行原纯函数反例：legacy control 接受，canonical 身份拒绝 `MARKETING_PUBLIC_CI_REPOSITORY_REQUIRED`；同一 canonical 身份被既有 `actionsMikkaRepository` 正确识别，原 `hasGitHubOrigin(canonical, legacy)` 返回 false。原进程环境未改变，未联网；manual/run/private pin 字段是明确标注的合成单元输入，**不是实际 dispatch 或私有源码版本**。执行耗时 0.114553429 秒只描述这个检查，不是交付提速指标。

在 50 个开放 PR 全分页中，只有 #2839 改过同文件的 telemetry 设置，无同根修复；#2981 只给这里的私有网站 owner 增加兼容，公开来源固定条件未变。最小方案是复用已有 `actionsMikkaRepository`，用其已核验的当前公开身份派生 workflow ref 和 origin，原 actor / main / pin / 回执边界全部保留。此项属发布来源准入，已经交主执行代理协调原 Owner；本轮没有修改或试跑发布。

## 明确排除与剩余边界

Factory visual workflow 在固定窗口出现 15 次 skipped。其 selector 只允许 #1789 的实际 merge `e93c58d23fd2608d664a5cee16218244b2377ab4` 与 source/current main 一致，当前 6fe 本来就不符合有限授权；不能将旧 guard 放宽后自动开启付费验收。其余 12 个受限工作流均详列在 JSON，当前窗口没有对应 manual dispatch。带 PR 入口的 read-cache / self-hosted / task-attachment / production-readiness，普通 PR guard job 与人工生产 job 分离。

保留旧历史 source URL、签名回执和真实 Alex actor；`Mikka-handoff` 是另一仓库，不能跟随本仓统一替换。Desktop 旧 `desktop-delivery/prepare.sh` 没有当前 workflow / package 调用路径；现行 Desktop CI 未见旧名字准入。`timings.mjs` 的旧 `gh api` 查找 URL 不是身份门槛，连接器的 301 不能证明原 gh CLI 失败，因此未捏造 collector 回归。当前 summary 使用 `GITHUB_REPOSITORY`，可跟随 canonical context。

此核查证明范围内的去重、精确故障和未解决边界；**不构成 #2984 全项目结项、受保护 CI 全绿或生产验收完成**。完整 54 工作流分类、50 PR 清单、139 native run、精确 jobs / steps、原日志最小摘录和本地反例分别保存在同目录 JSON，主报告逐项记录了文件 SHA-256。

## 后续 main 刷新：原 Owner 修复已合并

原 6fe 快照及其 50 PR／139 runs 样本保持历史含义。随后只读刷新到 main `59b7682fa34f80f402367d2bb40141034c9cf9fd`：54 个 workflow 文件名不变，47 个 blob 不变；6 个文件逐一等于 #2994 的正式合并 `ed905baee7482c43b29e8b15480ebbae160278c1`，第 7 个变化是 #3006 正式合并 `1d53f13c5753ef5f75b54e6f886a3b5fa3087733` 的 Browser gate 原生 `merge_group` 与 event/ref concurrency。Browser job 仍只输出回声，不计浏览器验收。

同一 JSON 的 `subsequentMainRefresh` 保留全部 54 个当前 blob／判定及 7 个变化的 Owner 归属。六项原 Owner 修复现在归为已合并；没有复制未合分支实现，没有增加 workflow 或平行身份 profile，也没有把这次 main 差异读取称为重新清点全部当前开放 PR。
