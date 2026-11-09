# #1512 checkpoint 42：e093 首轮完整原件，Native 预算仍为 RED

本 checkpoint 冻结 e093 的实际首轮，不把后续候选、功能绿色或 FIRST 的通过替代完整预算。**新正式生产验收仍为 0/2，issue 未关闭。**

## 固定来源

| 层次 | 固定值 |
| --- | --- |
| Feature head | e0934eb89f972d44ef6cffec6e27c16b4ed203bf |
| 实际 PR checkout | 114d370f807c465c0f6fe1be47e941aa19adf62a |
| 二者共同 tree | 0a0e2a40d82cbcb18963584e7d54f834a3af54fb |
| CI / attempt | 42678180995 / 1 |
| 实际 Node | 24.22.2 |
| 本轮实际安装的 Native daemon | 0.0.564 / 8db16095f46be955df22f42914e0f89b6e5f3d11 |
| 前 checkpoint | 7526d0f057dffa172d90c102eaacce7bac49dcad |

CP41 是发布前快照，其 sourcePublished=false 保持真实。此处记录18:54:01正常CAS发布后的实际执行。源码普通历史为6414→e7dfd5→272d578→e093；主线未由本方更改。独立重建6820个叶节点，最终原 checkout 父序为[d8,e093]且tree完全一致。

## 功能门禁与保留的失败

完整metadata：**10 workflows=9成功+1失败；40 jobs=31成功+8原条件跳过+1失败；41 checks=32成功+8跳过+1失败**。Root逐个核对job/check/run/suite关系，无分页、重复ID或状态缺口。最后UI policy(strict)七项true/success。

- Source实际361/361，含63项迁移测试。
- Core实际57 targets；A22及acceptance driver74逐名唯一通过，使用skip-nx-cache。
- Integration实际29 targets；完整Live三文件104/104、0失败/取消/跳过，新增C7及最后真实404降级均实际执行。
- PG3/4：18 suites、1673/1673，B23逐名通过。PG4/4：18 suites、685/685；新增真实Team revision helper用例把三次各一行合成一次三行且返回相同。只读取这两片的原日志，不冒充四片总测试数。容器和network精确删除有原件。
- e093 PR E2B 42678181268/A1真实失败：211=210通过+1失败，旧JavaScript负例错误要求Codex root CA的0644→0777抛错。后续Python/shell实际跳过。后来a83的绿色不覆盖此失败。
- 旧手动完整Live因硬截止未取到终态，仍为UNKNOWN。本轮新canonical结果是独立证据。

## Native 完整预算

| 原窗口 | SQL总数 | 分段 | unknown context | unknown statement |
| --- | ---: | --- | ---: | ---: |
| Web完整登录 | 427 | 19+0+408 | 87 | 128 |
| Native完整登录 | **451** | 19+15+417 | 91 | 138 |
| FIRST Native，原pair1 | 205 | 205 | 53 | 75 |
| FIRST Hosted，原pair1 | 207 | 207 | 53 | 68 |

**完整451>427，超出24，RED。FIRST205≤207。**24 records、12 checkpoints、8 segments、2280桶与1290连续ordinal守恒；Root及独立比较器一致，唯一预算错误就是完整窗口超额。不得从账中删PKCE、background或unknown，不移动窗口、ready或deadline，不选后续pair。Hosted FIRST真实chat completion crossesEnd227ms，保留原207，不加回。

Native完整physical/logical为16/41、Web35/35；FIRST Native6/18、Hosted18/18。额外null-action401记录没有新增SQL上下文，不凭逻辑调用数推断重复SQL。PG protocol bytes不是全网络或TLS成本。

原五对冷启动中位数4086.66ms/4163.67ms（Native快1.85%）不能抵销SQL失败。100屏自动像素比较通过；Root未亲自查看全部parity PNG，也未将它算作PostHog截图验收。

## 增量根因与修复边界

相对6414：Native完整+18、Web完整−4。新增26全部归于第三次bots.pollBots：其他三次各2查询，这次28。其余Native contexts合计−8：issues−3、task-runs−3、chat−1、summaries−1。两个C列表的原实际调用数未减少，定向测试通过不代表其已产生本轮计数收益。

18个known结构与现有ensureFor/backfillCoordinatorChat源码逐literal哈希对应，8个unknown仍unknown。API起点到该调用607803ms，与原10分钟回填周期相符；实际backfilled缓存时间没有记录，因此TTL时点仍是有源码支撑的推断。原件没有每条迁移语句rowCount，也不能直接声称这次迁移已被证明全为空。

FIRST Native209→205仅−4，Hosted147→207为+60，不把Hosted窗口差异当作代码优化收益。旧/新实际daemon同版本/源码，但这不是严格的单变量实验。

下一步只修真实空历史数据时的无效迁移工作：复用explicit-workspace路径已有Personal查询，只有active membership、已有Coordinator和严格false的保守legacy判定才省掉后续空事务。缺目标、未知或有历史数据走旧创建/锁/事务；TTL、失败重试、迟到旧行下一轮可见和权限合同不改。**此checkpoint不含已完成的新修复测试，也不声称反事实426就是实际通过。**

发布器修复的普通预合b1ce3e10fe5c5ae95584e6bcbc6008462593ef39（tree d1360faedd0d0067530f1325f7955732a618279d）仍未发布。仅这个不影响应用读路径的修复，不会用来抽取另一轮Native绿色。

## 清理、共享源与生产

生命周期workspaceNameCleanup保持phase=unchanged、restored=false；owner和peer的sealed-baseline各自before=false、after=true，与parity的restored=true分列。不能把这些布尔值压成一句“全为true”。

取证VM仅恢复两份已存在ZIP，19:30:02.464–19:32:54.357，171893ms，activeCPU6206ms；已stop/delete，精确同project/name的resume=false GET404。当前本方资源0；实际金额未知，没有说零费用。每个原job只一位reader、一次原日志工具；每个ZIP仅一次下载，其他复核复用Git原件。

19:44 fresh main仍d8，feature仍e093。#1835固定a83六workflow已绿，但仍OPEN/unmerged。#1503的实际19:12:47–20:42:47 source+SMOKE段在清理中，两腿失败的owner回执未等同于明确释放；#1505随后计划不构成未来预约。后续合并必须fresh核实际活动。

仍没有包含所需daemon修复的新生产runtime witness。Native安装版本不等于云worker，亦不要求AppSHA与RuntimeSHA必须相同。两条正式Personal模型调用、完整PostHog链、原生PNG亲见、Replay、controlled-failure开销及最终成本都尚未验收。

## PostHog 只读基线

19:19–19:24 snapshot：已有APM/AI Scouts均enabled/active/emit=true、1440分钟、Inbox-only、连续失败0；今日2/100。没有新建或触发扫描。billing product-view与usage_summary两个返回口径分开保留；金额null仍unknown。固定project670821当日timeseries返回空series，不解释成零用量。此为执行前基线，最终真实样本后需刷新。

## 文件与读取边界

index.safe.json列出54份payload，共8,355,283字节，不含本README和index。source-core-db与native-e0934e子索引记录各自原件、摘要、读取者和边界；root文件提供独立守恒、计数、实际source发布与完整metadata交叉检查。旧失败、未知与新候选各自绑定来源，均未重写。
