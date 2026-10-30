# 后端 issue 执行队列（2026-10-30）

此表是只读审计和分工记录，不是完成声明。基线为 `origin/main` / GitHub main `bed3e350558d6e4f5615640be500ed8fcce43360`（2026-10-30 20:03:36 UTC）。审计包含全部 **56 个 open issue**、9 个 open PR、近期整合 PR #401/#476/#513、旧候选与关键 issue comments。#191 已于 20:25:46 UTC 按用户“已合入的实现 issue 关闭”指令关闭，因此不再计入开放清单。

本次没有运行产品或 provider 验收、读取真实凭据、修改线上配置或关闭任何 issue。这里的“已合入”以主线源码和整合清单为依据；没有把旧 closed-unmerged PR 误称 merged，也没有把绿色 CI 当真实第三方验收。线上 flag 的现值未在本审计中读取：旧 comment 的配置快照不可当作当前生产事实。

## 分工与执行顺序

1. **正在并行的三个实现单元：#500、#499、#494。** 分别由父 agent、issue499 agent、issue494 agent处理；#499复用open #514；#490已有open #512，不能再开重复实现。
2. **马上增加旧后端任务：#176 和 #178。** 两项当前main都有具体未完成路径，并且旧分支存在更完整候选，可先比较并只整合必要delta。#176是可靠wake补偿，#178是在途设备凭据撤销。先不用新增provider、UI或付费资源即可推进隔离DB/HTTP/真实daemon验证。
3. **接着完成旧主线闭环：#179 → #177/#208，配合 #172/#342/#180。** #179先消费可靠wake；真实provider写入必须用明确受控目标，并记录独立读回。#330可与#500联合验收。#328只补真实失败投递样本，不复活已放弃的CI webhook驱动修复方案。
4. **清理与成本：#496可独立做，#503先只读观测。** #495/#497等#481；#501剩余规则等#504；#502删列等#490部署后的contract阶段。不要靠删掉组件库文件做清理。
5. **Factory同版本验收：#192/#193/#194/#195/#237。** 复用#401/#476已整合状态机、questions、review、monitor和Skill registry；先收#494，避免边验旧批准语义边改状态。只补当前实测失败或确实缺失的接线。
6. **企业控制：#207/#208/#209 → #210/#215/#230/#231/#232，再 #211/#212/#213/#214。** 先做入口/执行端覆盖与失败矩阵，利用现有局部控制和旧候选，按已证明缺口最小修复；不一次引入新组织架构、计费平台或重型监控。
7. **产品决策/前端依赖独立排队。** #184需archive/unlink选择；#390先定首批OS/浏览器和导入合同；#350后续推荐与手机触发按期交付。前端由现有Claude owner处理。

`AGENTS.md` 当前要求 **Ship features on**：普通已完成能力不能仅因缺schema或旧默认关闭开关而永久不开放；仅真实按次成本、事故kill switch或Alex明确决定可保留flag。此规则不允许跳过既有ask/deny、owner检查或随意执行真实外部写入。应分别证明“代码已合入”“部署/迁移与入口可用”“真实用户流程验收”，不把三者合并成一个勾。

## 全量清单

分类统计：前端 9；后端/工程工具 33；混合 8；总跟踪 6。混合项包含后端与独立前端/设备能力；总跟踪项不另算独立实现工作量。

| Issue | 分类 | 当前判断 | 下一步与证据 |
| --- | --- | --- | --- |
| [#504](https://github.com/alexj11324/Mikka/issues/504) 前端（Claude Code 负责，不分给 Codex）：Bot 与 Agents 页、设备页与 SSH 添加界面、R-74 共用标签组件 | 前端 | 未完成；独立前端owner | Bot/Agents、SSH设备页和R-74共用标签组件；#512/#511只覆盖后端；不得给后端agent重复写界面。 |
| [#503](https://github.com/alexj11324/Mikka/issues/503) C6 查 Vercel 调用量主要来源（8 天约 90 万次），砍掉不必要的轮询和心跳 | 后端/运维 | 可立即推进 | 先按真实Vercel日志统计近7天路径Top10，再改证据最明确的轮询；保持离线判定SLA并比较前后调用量。 |
| [#502](https://github.com/alexj11324/Mikka/issues/502) C3 + C5 个人访问令牌页放出来；删掉不再读写的设置列 | 混合 | 依赖阻塞 | C3令牌API与页面仍缺；C5删列等#490/#512替代规则上线后按expand/contract做；#482仍open。 |
| [#501](https://github.com/alexj11324/Mikka/issues/501) C1 + R-74 UI 规则检查脚本：纯图标按钮必须有 aria-label；设备/模型名必须用共用标签组件 | 工程工具 | 部分已合入；依赖阻塞 | C1经#508/#513进入main；R-74检查明确等#504共用组件，不应再次实现C1。 |
| [#500](https://github.com/alexj11324/Mikka/issues/500) B1 Agent 自己推分支、开 PR、用 gh pr checks --watch 盯 CI（凭据助手换 GitHub 安装令牌） | 后端/daemon | 本轮执行中 | 父agent实现run-scoped GitHub安装令牌、凭据助手和Agent盯CI；当前main仍由服务端代办，不能把webhook关闭当替代链路完成。 |
| [#499](https://github.com/alexj11324/Mikka/issues/499) A9 + A11 + A12 小简化：run chain 只留深度上限；Telegram 回复单事务；任务编号用计数列 | 后端/数据库 | 本轮执行中；部分已合入 | A9/A11已通过#509/#510/#513合入；A12已有open draft #514，由本轮issue499 agent续接计数分配与并发唯一性验证。 |
| [#497](https://github.com/alexj11324/Mikka/issues/497) A6 删掉 #481 留下的旧电脑审批代码 | 后端/daemon | 依赖阻塞 | 明确等open draft #481；之后删除本机ask broker/review端点等旧审批实现，与#495错开热文件。 |
| [#496](https://github.com/alexj11324/Mikka/issues/496) A5 凭据流程死代码：删掉两步审批链，只留一次复核和一次性租约 | 后端/凭据 | 可立即推进 | 独立清理fill/submit/clear两步审批和needs_approval；main lib/credentials/broker.ts仍读unattended_allowed；保留一次page-binding复核和一次性lease。 |
| [#495](https://github.com/alexj11324/Mikka/issues/495) A4 浏览器操作去掉审批流水线（#481 之后的剩余部分） | 后端/浏览器 | 依赖阻塞 | 明确等#481合并；随后within_task→deny→actionId幂等执行，改action-reviews.ts/browser-authority.ts；不要先拆坏现有接线。 |
| [#494](https://github.com/alexj11324/Mikka/issues/494) A3 + A8「批准」和「发布」合成一个动作；binding fence 收成 taskId + revision | 后端/Factory | 本轮执行中 | A1已通过#505/#513合入；本轮issue494 agent实现approve同事务预留发布、taskId+revision和失败可重批。 |
| [#490](https://github.com/alexj11324/Mikka/issues/490) Bot 与 Agents: backend for per-label execution rules (place · harness · model) and bot model choice | 后端/daemon | 已有未合PR；避免重复 | open #512实现per-label place/harness/model与bot model；先完成该PR评审、回归和整合，前端归#504。 |
| [#485](https://github.com/alexj11324/Mikka/issues/485) 第二阶段待办：#476 上线后按顺序做（过度设计简化 + Agent 自查 CI + QA 遗留） | 总跟踪 | 持续跟踪 | 第二阶段聚合；A1/A2/A7/A9/A10/A11/C1已勾选，不能随其中一个PR合入就关闭总项。 |
| [#408](https://github.com/alexj11324/Mikka/issues/408) Open implemented non-Linear features with verified runtime prerequisites | 总跟踪/发布 | 部分已实施；运行开放与验收不足 | 27项非Linear迁移及#409/#410/#414-#420已有交付；旧comment中的“无spend budget”已被#420更新。需核实当前部署配置与真实guarded-login/provider，不重跑已执行迁移。 |
| [#390](https://github.com/alexj11324/Mikka/issues/390) 按网站将本机浏览器登录态安全导入 Mikka 云电脑 | 混合/新能力 | 缺实现；产品与敏感数据范围待落实 | 明确是本机选定站点/profile→云浏览器导入；#180/#342仅云端session保存复用。先选首批OS/浏览器及合同，不能因这次代码任务去读取用户真实cookie。 |
| [#350](https://github.com/alexj11324/Mikka/issues/350) 主动推荐（R-73）：用户画像、夜间后台调研、限量卡片、即时触发和反馈 | 混合/推荐 | 部分已合入；后续缺实现 | #353仅画像/记忆阶段1；后台调研、排序限量反馈、即时触发仍需逐期实现；不要将画像页当整条R-73完成。 |
| [#342](https://github.com/alexj11324/Mikka/issues/342) 云电脑改版：每个云端线程一台机器，Bot 网页分身，点建议卡片直接开始 | 混合/云运行 | 后端已整合；真实执行与前端仍有缺口 | #346通过#401整合，#420增加spend guards；旧10/27comment“未合入”已过时。保留真实E2B/browser evidence，但真实native订阅推理、接管/暂停及当前同版本前端需补验。 |
| [#330](https://github.com/alexj11324/Mikka/issues/330) 验收 GitHub App 用户仓库授权与 PR 状态更新链路 | 后端/集成验收 | 实现已合入；真实验收未证明 | #333已提供个人仓库授权与PR状态；issue要求真实用户App安装/仓库绑定及Mikka实际任务PR读回，不能只凭webhook202关闭。与#500联合复验。 |
| [#328](https://github.com/alexj11324/Mikka/issues/328) 上线建议定时任务：仅剩 GitHub 真实失败投递的补投待验收 | 后端/运维验收 | 已上线；剩单项验收 | #329/#332已合入并有真实cron/早报证据；10/27最新comment仍缺真实失败投递→整点补投202样本。此为建议源事件补投，不是恢复CI webhook修复Agent。 |
| [#237](https://github.com/alexj11324/Mikka/issues/237) [P1] Factory：受控 Skill 自改进与固定基线评测闭环（非权重 RSI） | 混合/Skill | 大量实现已整合；真实闭环未验收 | #395/#401已有候选注册、baseline/candidate收集、评测和激活接线；10/26“仍只有模板”不能当当前事实。需真实Harness候选→固定基线→独立审阅→人审激活→监测，复用#192-#195/#232。 |
| [#232](https://github.com/alexj11324/Mikka/issues/232) [P1] 可信团队 Skill Plugin 注册分发与版本撤回 | 后端/Skill | 局部实现；产品合同与广泛执行端验证不足 | main self-improvement/registry.ts不是通用团队Plugin marketplace；先定注册源、审批角色、格式及撤回合同，再覆盖实际harness/缓存/resume/child；复用#237不可变版本。 |
| [#231](https://github.com/alexj11324/Mikka/issues/231) [P1] 服务端 provider model endpoint 准入与 fallback 子 Agent 防绕过 | 后端/策略 | 旧候选存在；当前统一能力缺口 | 旧closed #264有policy/model admission候选，但managed positive仍依赖#215且执行端传播未完成；不能把现有CLI模型选择/PR512当provider/endpoint/地区准入。 |
| [#230](https://github.com/alexj11324/Mikka/issues/230) [P1] Agent 集中强制策略控制面与运行版本传播 | 后端/策略 | 局部已有；组织控制面缺口 | main claim已经下发policy，issue旧文“claim不下发”过时；仍需组织强制上限、有效版本传播/撤回/离线TTL与child执行证明，复用#264候选并审其未整合依赖。 |
| [#219](https://github.com/alexj11324/Mikka/issues/219) 企业级 SaaS 缺口总览：安全正确性、上线运营与组织接入验收 | 总跟踪 | 未完成 | 企业SaaS总览#207-#215/#230-#232，覆盖矩阵与同版本证据聚合；不是又一个实现任务。 |
| [#215](https://github.com/alexj11324/Mikka/issues/215) [P1] 租户用量预算、并发配额与入口限流的执行门禁 | 后端/预算 | 缺统一实现；旧候选可复用 | closed-unmerged #265有预留/结算合同及候选；main #420仅thread-machine spend guards、attention预算也非全入口租户配额。先选可计量入口接通生命周期，再扩chat/tool/daemon。 |
| [#214](https://github.com/alexj11324/Mikka/issues/214) [P1] 软件供应链、漏洞响应与固定版本发布门禁 | 工程工具/发布 | 缺统一交付证据 | 已有固定依赖/CI和daemon发布基础；需锁定SBOM/来源、漏洞响应和版本发布门禁的实际覆盖，不另造更新器；与#230/#232执行端能力合同对齐。 |
| [#213](https://github.com/alexj11324/Mikka/issues/213) [P1] 租户数据导出、删除与保留策略的系统闭环 | 后端/数据治理 | 局部已有；跨租户系统闭环不足 | main lib/account/export.ts只证明个人导出基础，非企业tenant导出/删除/retention全链；先盘点数据/对象/provider retention，再做可恢复隔离测试。 |
| [#212](https://github.com/alexj11324/Mikka/issues/212) [P1] 端到端 SLI/SLO、可行动告警与事件响应演练 | 后端/运维 | 缺端到端运营验收 | 已有request日志与局部cron计数；仍需用户路径SLI/SLO、可行动告警和故障响应演练；先结合#176/#209具体失败路径，不空建监控平台。 |
| [#211](https://github.com/alexj11324/Mikka/issues/211) [P1] 跨数据库与运行证据的备份恢复、RPO/RTO 与灾备演练 | 后端/运维 | 缺恢复演练证据 | Neon恢复窗口或备份配置不等于跨DB/run evidence恢复；先隔离环境演练并测实际RPO/RTO，禁止操作生产恢复目标。 |
| [#210](https://github.com/alexj11324/Mikka/issues/210) [P1] 安全审计事件、租户导出、留存与防篡改验证 | 后端/审计 | 局部元数据不等于完整审计 | 旧#259/#264包含审计候选，main通用安全audit/export链未充分证明；固定事件范围与数据保留合同，与#178/#207/#208共同接线，勿导入未授权enterprise残余。 |
| [#209](https://github.com/alexj11324/Mikka/issues/209) [P0] 租约接管的 fencing、独立回收与跨机恢复验收 | 后端/恢复 | 已有重试/checkpoint；独立回收与真实双机fencing缺口 | main run-leases.ts明确回收依赖owner app/devices check-in；#185/#189/#201已有lease/worktree/checkpoint。补独立触发和旧attempt远端动作fence，不重做checkpoint。 |
| [#208](https://github.com/alexj11324/Mikka/issues/208) [P0] 跨 retry 的外部操作账本、幂等执行与不确定结果对账 | 后端/外部操作 | 账本已有；跨attempt/provider结果验收不足 | main lib/operations/ledger.ts、write-transaction.ts及#373/#374/#409已有持久执行语义；需逐provider核对stable operationId、uncertain查询及旧attempt拒绝，禁止仅靠prompt或event去重。 |
| [#207](https://github.com/alexj11324/Mikka/issues/207) [P0] 统一服务端授权与跨 workspace 隔离，覆盖后台与 Agent 工具 | 后端/授权 | 局部控制大量已有；一致覆盖与撤权矩阵不足 | 复用issue/workspace/member授权、claim/run admission和artifact现有边界；旧#264等候选不是主线通用覆盖证明。先做两workspace入口/撤权矩阵，发现真实失败路径再最小修补。 |
| [#195](https://github.com/alexj11324/Mikka/issues/195) Factory：监测故障去重回流现有 issue 与恢复验证 | 后端/Factory | 后端已整合；恢复闭环验收不足 | #389经#401整合；#468经#476加入hourly monitor sweep。不要重复写cron；核对真实故障→原issue去重→独立verification→发布→恢复的同版本证据。 |
| [#194](https://github.com/alexj11324/Mikka/issues/194) Factory：真实证据清单与绑定候选的人类发布批准门禁 | 后端/Factory | 已合入；本轮语义继续简化 | #388/#401/#426已有真实人类session批准；#513简化批准绑定；#494现改approve-and-publish。旧“必须trusted attestation issuer”已被后续Warp-aligned路径更新，不能仍当唯一阻塞。 |
| [#193](https://github.com/alexj11324/Mikka/issues/193) Factory：独立 review 与 verification 线程及失败修复重测闭环 | 后端/Factory | 后端已整合；真实独立执行与视觉验收不足 | #386/#401独立check/recovery已整合，#476有后续接线；需当前真实CC/Codex隔离执行、可信截图/模型判断和修复重测，模拟Harness/PNG只算分层证据。 |
| [#192](https://github.com/alexj11324/Mikka/issues/192) Factory：持久阶段状态与按任务歧义分流接入现有 Coordinator | 后端/Factory | 后端已整合；真实问答恢复待复验 | #385/#401已有routing/lifecycle/questions，#476补clarify卡片、线程问答等；先验证真实Agent提问→合法回答→原worktree/session继续及STOP，不照旧正文重写整个状态机。 |
| [#184](https://github.com/alexj11324/Mikka/issues/184) Allow a task to move back from workspace to personal after it reached Linear | 后端/Linear | 产品选择阻塞且代码明确保留限制 | main app/actions/issues.ts confirmIssuePersonalScope仍allowLinkedPersonal:false并注明archive/unlink待选；#301只整合fencing不能当linked回迁已支持。先确认archive还是unlink，复用现有retirement/outbox。 |
| [#181](https://github.com/alexj11324/Mikka/issues/181) 集成验收总跟踪：同版本 Mikka 真实 E2E 通过后才完成 | 总跟踪/验收 | 未完成 | 同一release固定app/daemon/workers/schema/配置，贯通#172/#176-#180；真实provider/OAuth与普通隔离系统验收分别记录，不新增第二套路线图。 |
| [#180](https://github.com/alexj11324/Mikka/issues/180) 安全凭据表单后端：接入 Agent/Coordinator、真实 vault 与受控浏览器验收 | 混合/凭据 | 后端已整合；当前登录/UI/开放验收不足 | #345/#346经#401整合；最新10/29comment有Preview OIDC→角色/KMS正确context与wrong-owner拒绝。仍需当前同版本真实secure-card→guarded-login闭环；不能把旧“未合入”或旧prod flag状态当现况。 |
| [#179](https://github.com/alexj11324/Mikka/issues/179) 定时任务后端：对话 Agent 创建、持久化到期唤醒与真实结果回报 | 后端/定时 | 当前main缺接线；旧候选可复用 | 当前未发现通用schedule表/工具/due worker；closed #269+#271+#276有会话schedule/DST/公平重试候选，#300只保留Telegram delta。先#176，再恢复最小一次性/重复聊天schedule，不做新UI。 |
| [#178](https://github.com/alexj11324/Mikka/issues/178) 设备：真正撤销 daemon 凭据，而非仅停止 dispatch | 后端/设备 | main只局部实现；可立即整合旧候选 | main removeOwnedDevice仅无live run时撤销token；不足在途撤销/事务审计/SLA。closed #273+#275已有真实daemon17端点拒绝、同连接事务fence与故障回滚，先审差异复用再接当前设备入口。 |
| [#177](https://github.com/alexj11324/Mikka/issues/177) Connected apps：邮件/日历/文档/Slack 最小可执行工作流与审批验收 | 后端/集成 | 已实现部分；默认开放和真实provider验收不足 | #204/#308/#373/#374/#409有email/calendar/Notion/Slack路径；main write-feature.ts默认false。按AGENTS启用完成的普通功能且保留每次ask/deny权限；实际provider用受控目标读回，不擅自发消息。 |
| [#176](https://github.com/alexj11324/Mikka/issues/176) Coordinator：持久化 wake 投递、重试补偿与真实集成验收 | 后端/可靠性 | 当前main有明确缺实现；可立即推进 | main lib/coordinator/wake.ts注释与catch仍“失败等下一事件”；旧#276继承#269/#271有补偿候选，#300/#401只覆盖Telegram部分。补持久wake重试/独立补偿及提交前后故障验收。 |
| [#172](https://github.com/alexj11324/Mikka/issues/172) Cloud computer backend: E2B, per-bot desktops and dual-path BYOS | 混合/云执行 | 大量实现已合入；双路径真实订阅仍待验收 | #317/#401/#406及#420已有desktop/runtime/网络与spend guards；必须分别验证Mikka bot subscription推理和hosted官方CLI，不拿云基础设施或本地smoke代替双路径。 |
| [#159](https://github.com/alexj11324/Mikka/issues/159) 字号阶梯 12/14/16/24 与设置页外壳统一 | 前端 | 部分旧PR覆盖；待现行设计核对 | #76已有侧栏国际化，#14/#165/#241改外壳；#477/#482设置链仍open。字号、团队chip及现行设计需前端逐项核对，不凭PR标题关闭。 |
| [#158](https://github.com/alexj11324/Mikka/issues/158) 视觉打磨：删说明文字、品牌色上数据、灰度收两档 | 前端 | 部分已合入；需按更新设计核对剩余 | #165/#241/#288覆盖许多文案/灰度/头像；运行态绿色等后续规则已替代旧蓝色要求，不能重新按旧稿改回。 |
| [#149](https://github.com/alexj11324/Mikka/issues/149) [MIK-50] Computer use：daemon 在本机启动 cua-driver | 后端/daemon | Linux已接入；实际macOS/完整Agent验收不足 | #161已合入真实Xvfb driver+sandbox验证，CLI/model为合成；10/30comment默认ask被#481方向取代。先跟#481/#497整合，再真机验收。 |
| [#147](https://github.com/alexj11324/Mikka/issues/147) [MIK-48] Computer use：接入开源 CUA（远程桌面 + 本机 daemon） | 总跟踪 | 被后续路径部分替代 | remote部分由E2B/#172/#342替代，本机由#149；不恢复Cua Spaces/spacesd旧方案，复用MIT cua-driver。 |
| [#131](https://github.com/alexj11324/Mikka/issues/131) [MIK-36] 顶部全局 ⌘K 搜索 | 前端 | 多批已实现；完整搜索范围仍需核对 | #165全局入口、#348后端title search、#318/#401客户端已整合；知识库和完整前端范围仍非仅凭这几项可关闭。 |
| [#129](https://github.com/alexj11324/Mikka/issues/129) [MIK-34] 新用户首次打开（onboarding） | 前端 | 已有未合PR | open #478实现first-run guide，归前端owner；不要另做一版onboarding。 |
| [#124](https://github.com/alexj11324/Mikka/issues/124) [MIK-29] 中栏会话接入 OpenUI | 前端 | 部分已合入；群聊仍有缺口 | #92/#154统一Coordinator/OpenUI/chips；main GroupChatView仍直接body文本且只读，不能宣称所有会话均已统一。 |
| [#121](https://github.com/alexj11324/Mikka/issues/121) [MIK-26] 动效：无整屏过渡 | 前端 | 需现行切换行为验收 | 已有shell/motion基础，仍应验右栏保持tab/已开线程及唯一tab胶囊动画；静态无整屏AnimatePresence不足完整验收。 |
| [#110](https://github.com/alexj11324/Mikka/issues/110) [MIK-15] 群聊：agent 之间私聊的时间线标记和只读视图 | 混合/群聊 | 数据基础存在；链路/UI仍缺 | main conversation_links表存在，旧closed #277有source-scoped readonly交换候选；当前GroupChatView尚未完整展示exchange标记/只读弹层。与#109同owner接口衔接。 |
| [#109](https://github.com/alexj11324/Mikka/issues/109) [MIK-14] 群聊：前端界面 | 前端 | 缺完整可写群聊UI | main GroupChatView明确read-only、无composer；成员/@/往来标记等仍待前端，不因group schema/API完成就关闭。 |
| [#105](https://github.com/alexj11324/Mikka/issues/105) [MIK-10] 群聊（多 agent + 用户）总 issue | 总跟踪 | 后端基础已有；全功能未完成 | #155 schema/API、#95路由和后续group-turn实现已有，#109/#110/#101仍需整合验收；不重造会话模型。 |
| [#101](https://github.com/alexj11324/Mikka/issues/101) [MIK-6] 群聊输入框上方的「谁正在工作」状态条 | 前端 | 缺完整可见交付证据 | 群聊“谁正在工作”状态条及shimmer/人员切换跟#109设计接线；后台active sessions不等于状态条完成。 |

## 旧候选复用的边界

- **#176 / #179：** #269是会话schedule候选，#271补skip决策与失败报告公平重试，#276补durable消费与wake恢复。#300的Telegram回复delta被#401保留，不代表这三个候选的全部代码进入main。当前 `lib/coordinator/wake.ts` 仍明确“失败等待下一事件”；当前未发现通用schedule表、tools或due worker。先对照这几条候选与当前同名业务入口，不能整条导入其旧auth/schema祖先。
- **#178：** 当前 `lib/device-removal.ts` 拒绝live run时移除设备，并在空闲移除时撤销相关token。旧#273/#275覆盖更多真实daemon/API端点、同连接事务fence和故障回滚，但原PR还明确保留实际native CLI停止SLA等限制。整合后仍需对当前版本重验，不能引用旧候选SHA冒称新版本已测。
- **#184：** #301整合了scope/publication fencing；当前 `confirmIssuePersonalScope` 仍显式 `allowLinkedPersonal: false`。linked任务回迁不是“只有验收没做”，而是仍缺产品选择与执行接线。
- **#207-#215 / #230-#232：** #264/#265等closed候选包含policy/budget/audit合同与多项测试，但不在#401的public integration范围内；正向managed provider、child、reserve/settle等原合同仍有缺口。先确认具体入口和依赖，不从文件名推断整套企业能力可用。
- **#237：** main已有真正candidate registry、baseline/candidate collector和激活绑定，来自#395/#401。旧10/26报告中的模板阶段只能作历史失败证据；剩余应以当前真实Harness执行、固定基线对照和人审激活/恢复来验收。

## 核查来源

- [Public integration #401](https://github.com/alexj11324/Mikka/pull/401) 及 [frozen manifest](public-pr-manifest-20261029.json)：区分 integrated、covered-by-current-or-successor、excluded。
- [Overnight integration #476](https://github.com/alexj11324/Mikka/pull/476)、[backend simplifications #513](https://github.com/alexj11324/Mikka/pull/513)：防止把已整合旧功能重复分派。
- [#408 execution comments](https://github.com/alexj11324/Mikka/issues/408)、[#180 latest OIDC/KMS comment](https://github.com/alexj11324/Mikka/issues/180)、[#328 remaining sample](https://github.com/alexj11324/Mikka/issues/328)：只采用其明确的证据范围与时间。
- 源码检查：`lib/coordinator/wake.ts`、`lib/run-leases.ts`、`lib/device-removal.ts`、`app/actions/issues.ts`、`lib/operations/write-feature.ts`、`lib/credentials/runtime.ts`、`lib/self-improvement/registry.ts`、`components/workspace/group-chat-view.tsx`。

每个交付PR在最终固定代码上记录相关源码测试、真实隔离DB/API/daemon测试、CI链接和未执行的第三方/真机步骤；只有满足该issue自身范围和适用验收后才请求关闭。此表不会代替具体issue的验收合同。
