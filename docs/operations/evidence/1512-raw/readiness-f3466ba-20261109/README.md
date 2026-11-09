# #1512 CP31 — f346 完整CI、原始Native与生产前证据口径

候选 f3466ba479ef51918790f521a288feaef5160e44，实际 CI checkout 855245dba9accc3212dab9fd28af398af1a7e65a，tree 102bc671b4c5e3cf49fcce54025c71b26f817cf2。CI42610943512 已于12:08:30 UTC完整SUCCESS；22jobs=21success+原OIDC skip，head51checks=40success+11原条件skip，14workflows全部success。本轮原始Native完整窗口及FIRST pair已由Root独立复算。此检查点不表示生产验收完成。ACME accepted cases=0。

## 本轮源码的实际证据

- 唯一读者各取一次 Source129139328386 与 Database2/4 129139328508 原作业日志，原件、逐段 receipt 与 Root 独立算术均封存。
- Source 七个 Node 汇总为46+7+29+63+102+69+45=361 PASS，fail/cancelled/skipped/todo全部0。这里63是迁移测试。
- PG2 18个选中 suite 合计806 PASS，fail/cancelled/skipped/todo全部0；test:groups 的12+82=94按两个真实汇总保留。上游 e78 改动的三个活动行断言实际通过。其余三片本轮 job metadata 为success，不将旧源的叶计数搬来冒作新执行原件。
- 全部选择清单与 ae10 完全同字节；其原件见CP30。当前候选相对实际main e78为479路径，包含待原owner先合的P0依赖。
- Source/PG2各取证一次，没有新测试运行、账号请求、模型请求或VM。

## 更正 CP29 的 driver 归属

CP29原件保持原样。CP29派生报告52057ad63bccd8c3b580c3610c4cb5011128aded及其README把Source的63项迁移汇总标成driver，此标注错误；完整更正见 ae10-driver-attribution-correction.safe.json 和PR评论6739435139。

真正的63项driver在 ae10 Core129114784847 的 ci-tasks:core-53 / test:dev-local中执行。Root把CP27隔离GREEN原件的全部63个Subtest名称，逐个唯一匹配到Core原件的成功行6583–6645（normalized one-based）；其中含12个严格404用例。Core组合日志没有独立driver 63行总计。该更正不改变原通过结果，也没有重读原job或重跑测试；不把它改标成 f346 Core已逐项复核。

## 本轮完整 Native 原件

Native job129141935329 success于12:08:15，未重跑。新artifact13672166131与13672430500各下载一次，ZIP bytes/SHA/testzip及310个member登记；五份关键JSON完整原字节持久化。Root单独读取这五份不可变blob并核对索引，重新计算24records、12checkpoints、8segments、2280个桶值、1252个ordinal，错误0。

完整Native426=19+13+394≤Web435=19+0+416；原第一对启动Native158≤hosted233，pair=1。登录、email/auth、PKCE、真实导航、后台API流量均仍在原窗口，未移动边界或扣除后台。首Native physical5started/3completed/crossesEnd2、logical14/13/crossesEnd1；这些已确认跨窗请求不能写成窗内完成。其余窗crossesEnd=0。四窗context/statement unknown分别Native91/129、Web87/132、首Native53/53、hosted53/77；diagnostics仍incomplete，capturedQueries与原调用计数完整相等，overflow=false、dropped=0。

100个parity行覆盖50屏×2主题，原threshold0.001/color0，无pageErrors；129600000比较像素、264changed、最大比0.00010262345679012345；56屏使用原avatars/timestamps mask。Root未查看其PNG，未声称像素人工验收。3个独立crypto进程通过，原package与crypto.package逐字段相等，严格签名/包合同保留。

lifecycle workspaceNameCleanup restored=false/unchanged；owner与peer基线beforefalse→aftertrue，smoke独立before/after均true、restored=true，parity restored=true，不能混写成全部原值一致。实际installeddaemon仍0.0.551/facb389f6cc06c453e9135bb60ada1b0f302e0d9，并非candidate发布。

唯一取证VM sbx_Kd7mxF5KayM7Ifw0TnYm9D3c6A0P，12:09:36.405至12:12:11.950，155545ms、6808CPUms，ingress14932318B/egress397039B；实际stopped、delete、相同name/project/team且resume=false GET404/not_found，0延期，当前自有活动资源0。金额未计量，不能称零成本。

## PostHog scouts 与计量

四次各一次官方metadata读取，未执行SQL、模型、写操作或变更plan/cap/retention。Root从四份allowlist回执独立复算全部5×24个日桶。

两个APM/AI scout enabled=true、status=active、emit=true，Inbox启用、无Slack/Webhook，间隔1440分钟，连续失败0；today2/100，remaining98。last_run_at为11月9日06:30/07:30，只是metadata，未独立确认报告完成。下一次精确执行时间未知。

11:47组织Billing当前账期为2026-10-17 17:45:01.620至11-16同刻：free、无active subscription，Logs447MB、AI1117events、Replay18；cap分别10000MB/100000events/5000recordings，均未超限。美元字段null，实际美元费用unknown，不能写$0。

11:49项目670821按UTC日级10-17至11-09（含末日）计量：Logs+Tracing373MB、APM324MB、Logs47MB、AI857events、Replay16。373与324+47差2MB未解释；组织与项目差额也未归因。next=null；末日0不证明没有摄入。组合项不与分项相加，计量不证明本issue真实案例或Replay已播放。

## Factory 源码分支边界

前一位owner的operation=reject失败不能直接判定本方operation=accept也会失败。固定f346源码的no-repository accept分支要求live owned session与任务owner/workspace/evidence/CAS，没有reject/approve分支的GitHub/Google provider predicate；通过后在访问GitHub token前返回。此项仅为源码审查，不是ACME账号或生产accept验证。未来实际main改动相关文件时应复核真实增量，不能据此跳过生产验证。

## 仍待完成

P0原owner合并和实际发布/有限窗口交接；两条官方订阅真实ACME案例、全部generation、14查询完整分页/两个稳定快照、原生PNG实际像素、Replay实际播放、Notebook、最终源20失败保留率与600/100实测开销，以及全部本方资源清理。issue仍open，PR未合并。
