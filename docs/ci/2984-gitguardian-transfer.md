# #2984：迁仓后 GitGuardian 原生回执核查

快照整理时间：2026-11-21 00:46:58 UTC。只读核查，没有修改仓库保护、App、Secret、扫描配置、身份或生产状态。

## 裁决

**公共仓现行规则仍要求原 GitGuardian 检查。新 head 上没有检查记录，是外部集成／验收回执缺口，不能记为成功，也不能用原生保护只列三项 Actions 检查来解释为豁免。**

快照时的 main `ed905baee7482c43b29e8b15480ebbae160278c1` 的 [workflow README](https://github.com/aspectly-labs/Mikka/blob/ed905baee7482c43b29e8b15480ebbae160278c1/.github/workflows/README.md) 明确列出独立外部必需检查 `GitGuardian Security Checks`；[AGENTS](https://github.com/aspectly-labs/Mikka/blob/ed905baee7482c43b29e8b15480ebbae160278c1/AGENTS.md) 和 [CONTRIBUTING](https://github.com/aspectly-labs/Mikka/blob/ed905baee7482c43b29e8b15480ebbae160278c1/CONTRIBUTING.md) 的最新 Draft/Ready 规则继续保留它。[#2997](https://github.com/aspectly-labs/Mikka/issues/2997) 明确外部 GitGuardian 不变，[#2984](https://github.com/aspectly-labs/Mikka/issues/2984) 明确禁止绕过。

旧 README 句子来自正常提交 `656f3e2f1bbc740cbcc4c1fd2d956663d9d9af87`；这并非只靠旧句子作裁决：最新明确保留条款来自 `719af8dde7b6592bf93b71f569f1adcc96abb899`（#2997）。已读取的浏览器门禁决策仅处理浏览器检查，不撤销 GitGuardian。

## 原生记录

| 范围 | 固定来源与原生结果 | 可得结论 |
| --- | --- | --- |
| Public 先前候选 | #2986，head `59f01f483c0d6ba69109396546bd5840d69c0bff`；32 check-runs 中包含 GitGuardian App 46505，check 136583210537 于 11-20 21:34:17 UTC success | 这是真实原有外部集成 |
| Public 迁仓后候选 | #2994，head `40571ce6c780d4044f3c664099e060c857085879`；34 check-runs 全来自 Actions；8 suites 只有 Cursor、Claude 和 Actions；0 commit statuses | 没有该 head 的 GitGuardian 执行／成功回执；PR 已于 00:30:45 正常合并，不能事后把缺检查写成通过 |
| Cloud #418 | 原较早 head 的 check 136582941537 于 21:33:46 success；当前 head 为 0 check-runs、2 suites（Cursor/Claude）、0 statuses | 较早版本成功不能覆盖当前版本；准确私有 SHA 留在私有原始快照 |
| Cloud 独立时间点 | #427 的 check 136633312437 于 23:22:05 success；#428（23:39）和 #433（00:32）的各自新 head 均为 0 check-runs、2 suites，无 GitGuardian | 缺口不只出现在 #418，仍不能据此断言 App 已卸载 |
| Hosted UI | 当前 #259 head 的 check 136634044982 于 23:23:49 success；#258、#256 当前 head 也各有一次原成功扫描 | 精确旧 head 的成功仍是事实；未观测新 post-transfer push，不能据此推断新提交仍会触发 |
| 快照时 Public main | ed905 的完整返回 48 suites 中无 GitGuardian，部分 Actions 仍运行或排队 | 只是读取时点的记录，不是完整 main CI／发布验收 |

这些是有目的的固定来源样本，不能转换成全仓触发率。分母：Public PR 前／后各 1；Cloud 较早有扫描 head 3 个、较新缺扫描 head 3 个；Hosted UI 当前有历史成功 head 3 个、新 post-transfer push 0 个。所有原生列表使用 `per_page=100`，返回 total_count 均小于 100。

`status=pending,total_count=0` 不等于 GitGuardian 正在排队；Cursor／Claude 的 queued suite 也不是 GitGuardian。

## 原生保护与项目要求分开记录

Public 的 `branches/main` 返回 `protected=true`，可见 required contexts 只有 `UI policy (strict)`、`Production build and browser interactions`、`Browser tests (before merge)`，均绑定 Actions App 15368。可读取的 public rulesets 是空列表。完整 classic protection 接口返回 403，因此没有声称取得全部管理员设置。

两个私仓的 branch metadata 返回 `protected=false`、空 contexts；完整 protection 都为 403，rulesets 返回当前私仓计划不支持该功能的 403。没有修改这些设置，也没有建议新增付费计划。

私仓当前 AGENTS 没有单列新的 GitGuardian required status；Hosted UI 明确继承公共安全 guard。两个私仓都有可独立核实的原 GitGuardian 集成记录。因此应保持原安全保障并解决新 head 的缺口，**不是由本专项另造一个 GitHub required check，也不能把旧 SHA 的 success 搬到新 SHA**。

## 所有权与未知项

已读取 #2978、#2981、#2994 的当前 PR 正文、#1953 的 50 条评论、#1954 的 120 条评论、原私有生产 Issue 的 10 条评论，并检查当前 54 个开放公共 PR 的相关声明。最新 [#1954 转仓回执](https://github.com/aspectly-labs/Mikka/issues/1954#issuecomment-7053373965) 确认 canonical 仓库，但没有声明 GitGuardian 目的组织安装／触发已验证。提到的 source App、产品 App 和 OAuth 不能替代第三方 GitGuardian App 46505 的证据。

**根因仍未知。** 原生 API 只能证明选定新 head 没有生成 GitGuardian 检查，不能区分安装范围、仓库选择、事件投递或提供方配置问题。没有读取安装清单、Webhook delivery、GitGuardian 账户配置或 token；也没有换身份请求扫描。

最小所有权裁决：由原仓库／组织和 GitGuardian App 集成 Owner 核查目的组织的现有集成范围与原生事件回执，并恢复适用精确 head 的原检查。#2984 保留这个外部依赖及证据缺口，继续可独立执行的代码工作；不改保护、不修改扫描范围、不新增替代扫描器、不发额外生产版本，不冒认已有 Owner 完成了 App 迁移。

机器可读摘要：`2984-gitguardian-transfer.json`。完整私有 SHA、私有政策及原生原文另保存在私有分析快照，不放入公开交付。

## 官方集成所有权边界补充

[GitGuardian 官方 GitHub 集成文档](https://docs.gitguardian.com/internal-monitoring/integrate-sources/vcs-integrations/github)说明：GitGuardian Owner／Manager 配置集成；组织安装需要组织 Owner，普通成员可以请求安装。GitHub App 的安装／仓库访问范围与 GitGuardian 实际监控范围分别配置，仓库可以仍在安装范围内却不被监控。

[GitHub 官方现有 App 安装文档](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps)说明组织 Owner 可调整安装的仓库访问范围，仓库管理员可将其仓库加入现有安装。这些是原 Owner／管理员的正常操作边界，**不是目前 App 未安装、被暂停或配置错误的证据**，也不是本专项改变 App、账户、保护或扫描门槛的授权。上述精确 head 的缺回执结论仍保持未验证；实际根因需要原集成 Owner 的原生记录确认。
