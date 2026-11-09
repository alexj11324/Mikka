# CP45：84ce 最终 CI 与原始 Native 预算

## 当前结论

固定 head `84ce7f876817f0d73c34a1ef89797fc27ba8661e`、tree `e7c7c6ad66acd729278393711c10eeed67c6d7ac`；本轮 Actions 实际 checkout `197ba2452796ce6d5942309f488009963b7cbc7d`，tree 相同。

本轮 10 workflows 全部 SUCCESS；40 jobs 为 32 SUCCESS / 8 SKIPPED；41 checks 为 33 SUCCESS / 8 SKIPPED。Root 与独立 reader 从各自 metadata 对照 exact job/check IDs、head、终态和分页数量，0 缺口。唯一外部 check 为 GitGuardian。未把 17 个 check suites 全称为 SUCCESS。

CI 42691592260/A1 的 Native job129416680401 于 20:42:40 UTC SUCCESS，实际 packaged 验收步骤 20:34:30–20:42:26。最终 strict job129426293088 于20:42:55 SUCCESS；原日志的七个 expected=true 依赖均为 success，Changes 为 success。

**本 checkpoint 没有生产双模型验收结果；仍为 0/2。PR1799 未合并，issue1512 仍 OPEN。**

## Native 原始完整窗口

| 原窗口 | 实际 SQL | 原分段 | unknown context | unknown statement | 未捕获 |
| --- | ---: | --- | ---: | ---: | ---: |
| Web 完整登录 | 427 | 19+0+408 | 87 | 128 | 0 |
| Native 完整登录 | 426 | 19+15+392 | 94 | 130 | 0 |
| FIRST bundled，pair1 | 198 | 198 | 53 | 69 | 0 |
| FIRST hosted，pair1 | 228 | 228 | 53 | 75 | 0 |

完整 Native **426≤427**，原始首对 **198≤228**。完整 email、PKCE、navigation、后台流量和 unknown 均在原窗口内；没有扣除 unknown、重划边界、换首对或重跑同源取绿。四窗 physical/logical crossesEnd 均为0，不能继承历史e093的227ms边界。

Root 从五份 Git 原件独立核验字节与 SHA，再复算 **24 records /12 checkpoints /8 segments /2280 桶 /1279 ordinals；errors=[]**。独立 reader 的结果一致。overflow=false、droppedQueries=0；细分归因仍 incomplete。

RPC physical/logical：Native完整14/40，Web完整35/35；FIRST bundled6/19、hosted19/19。计量范围为主 API 进程实际 pg.Client.query 与 PostgreSQL 协议字节，不是整机网络流量。

历史e093完整 **451>427 RED**、FIRST **205≤207** 原样保留。当前通过不能改写历史或证明全部净差来自代码。真实 PG 空回填26/26/27/29→1已在CP43独立验证；本次 Native 是否实际走到该due路径必须按原ordinal判断，不能借PG对照补造Native调用。

## 其他原件与资源

原5对冷启动 bundled 中位2560.78ms、hosted3264.78ms；只属于本轮原测量，原合同未新增时延阈值。Parity原报告100屏/129600000像素、263变化像素、最大比例0.00003935185185185185，pageErrors=[]。Root未直接查看这些parity PNG像素；该报告不是本issue所需PostHog原生截图。

实际 Native daemon 为0.0.564 /8db16095f46be955df22f42914e0f89b6e5f3d11，与云worker来源分别记录。crypto三次独立进程、包签名及原smoke通过。

生命周期workspaceNameCleanup保持phase=unchanged/restored=false；owner/peer sealed-baseline before=false/after=true。Smoke before=true/after=true、smoke/parity restored=true单独保留，不合并成一个虚假的restored=true。

Native唯一reader读取原job log一次、两个ZIP各一次。两个ZIP均核API digest，310文件manifest和五JSON原字节已冻结；复核只用Git原件。唯一取证VM于20:46:49.340 UTC stopped，随后delete及exact same-project/name、resume=false GET实际404；duration147716ms，active CPU6633ms。未延期，自有资源0；实际美元费用UNKNOWN。

Source/Core/Integration/PG3/PG4/E2B及DBsummary原件见CP44；真实PG RED/GREEN、测试修正和全源码合流见CP43。DBsummary job的显示名不被解释为另一次生产build/browser验收。

## PostHog费用准备

`posthog-pricing-readonly-proof.json`是公开价和账期快照准备；后续`posthog-mcp-pricing-verification.safe.json`通过当前权威MCP文档补充Vision单位价格，明确其对旧proof中Vision unknown的局部更正。

Logs公开免费10GB/月，首付费档0.25美元/GB，300GB以上0.15美元/GB；AI免费100000 events，首付费档0.000350美元/event；Web Replay免费5000 recordings，首付费档0.005美元/recording。公开价不是实际账单，组织共享额度不是本issue预留。

当前MCP明确Vision每credit为0.01美元；成功Gemini 3 Flash observation为5credits。两条实际成功且模型匹配时，计划名义10credits/0.10美元，尚未扣免费额度，也不是已经花费；最终以实际observation model/credits为准。所有$ai_事件按AI计费、不重复算Product Analytics。APM具体数值单价/计费usage-type映射及Scout每调用金额仍UNKNOWN；不把OTLP/JSON bytes当billable GB。

本轮只做文档核验，没有Vision调用、Scouts重触发、额度或计划修改。生产案例实际量与实际美元费用仍待后续事实，不能填0。

## 当前共享发布边界

20:52:20–20:53:31只读快照：main已由PR1838普通merge至12458fe22e1217f644e8b28f82ab856211e73b72，仅README.md/README.zh-CN.md变化。原7848 Web SUCCESS；R7真实订阅步骤FAIL，publish SKIPPED，cleanup SUCCESS。候选aa7不是已发布runtime。

#1505原20:04:10–22:04:10实际窗口尚未明确释放，child尚未撤销。其Codex门槛失败由owner按原件处理，本方不重复读原日志或ZIP。新main自己的Web/R7已实际运行。本checkpoint不移动main、不预占未来窗口。

## 后续验收范围

待实际发布/账号窗口释放后，正常merge自身PR并核生产Web和public version；分别执行官方Claude Haiku5.5/GPT6 Luna的Personal真实UI单次任务。核同trace完整父树、每generation、Logs、实际Replay播放、PostHog原生PNG及可用timeline，保留真实清理/费用/巡检证据，再手动关闭issue。

历史故意失败20traces/80spans/40ERROR和Web内存exporter开销mean+0.344583ms、p95+0.436580ms保留其实际范围；不扩成当前生产全部daemon开销。CP43已有依赖适用性和serverless新增drain分支边界。

`pr1799-before-cp45.md`保存更新前PR完整正文，含此前每个阶段的历史结论；新正文更新当前状态不删除这些历史原件。
