## 当前 84ce：空回填真实 PG 已验证，完整 Native 正在执行

固定 feature **84ce7f876817f0d73c34a1ef89797fc27ba8661e**，tree **e7c7c6ad66acd729278393711c10eeed67c6d7ac**。20:17:40 UTC 正常 CAS 更新自有分支；有序 parents 为实际测试候选5a0c907和真实main合并7848e79，未移动main。新CI [42691592260/A1](https://github.com/alexj11324/Mikka/actions/runs/42691592260) 实际 checkout **197ba2452796ce6d5942309f488009963b7cbc7d**，tree相同，parents=[main7848,feature84ce]。

**#1512 新正式生产验收仍0/2，issue保持OPEN，本PR不自动关闭。** e093完整Native **451>427、RED+24** 保持原结论。新Apple Native job129416680401已于20:25:27 UTC开始；当前没有新完整预算或FIRST结果，不能按预测减去SQL就判通过。

### 真正修复的读路径与实测

已有active-owned-Personal读取附带11类旧数据的保守EXISTS判定。只有已有Personal Coordinator且数据库严格返回false才跳过空ensure/migration；未知、缺目标、权限不足、有旧数据或失败保留原路径。迁移尾部、锁、原10分钟周期、Native harness/窗口/ready/deadline/首对选择全部不变。测试最终新增316行、21子例，原测试全文逐字保留。

[真实隔离运行42690271741/A1](https://github.com/alexj11324/Mikka/actions/runs/42690271741)：

| 对照 | 实际结果 |
| --- | --- |
| 旧e093 + 同一修正测试 | 47 tests /42 pass/5 fail：恰好4个指定ERR_ASSERTION子例及父汇总，0skip/cancel/todo；25旧子例全过 |
| 四个旧源空路径 | Personal26、Team26、已复制head27、晚到family29；期望均1 |
| 新5a0，原完整25-file Coordinator族 | **375/375 PASS，0fail/skip/cancel/todo**；Coordinator旧25+新21全部通过 |

两个阶段使用独立runner、全新PG17/loopback数据库，原72-suite inventory和原required DB runner，Node24.22.2/pnpm10.34.3；没有生产凭据。Root从冻结原TAP独立重算，未把runner的流式镜像重复计数。

前一控制器YAML启动失败42688581877（无job/PG），及前一夹具错误42689043866（NOT_VALID_RED、GREEN未启动）均保留。三处夹具修正只处理UUID/text参数与Factory attempt外键，未放宽断言/白名单/限时或重复触发相同源码。旧/新原日志均每job唯一reader一次，ZIP零下载。

### 完整证据与当前门禁

[CP43完整索引](https://github.com/alexj11324/Mikka/blob/e1fb8f50cdde7c570c4f8144ba3e6724ce414a23/docs/operations/evidence/1512-raw/coordinator-empty-backfill-20261109/index.safe.json) 保留64 payload /6,880,425 B，加README/index共66文件。普通单父提交、全部path/mode/blob及ref已读回。包含失败原件、修正、RED/GREEN、Root复算、实际source/checkout、worker输入及生产验收准备。

截至20:27，本轮Source/Core/Integration及四片DB元数据均SUCCESS；各指定原件正逐名核验。PR E2B离线原件为Node215/215、Python32/5/38/16全部PASS及py_compile/bash语法通过；该PR的六个生产job原条件SKIP，不能当作正式R7通过。Native与最终strict仍待自然终态。

最终隔离PG均已stop并由Actions移除container/network，自有服务0；Ops已正常关闭215f846，enabled=false，closing42691624148的两个job真实SKIP。实际主线7848与本PR18个canonical worker选择项原始对象全同；这是源码输入关系，不是已观察到新的运行时发布。共享主线R7仍按其实际build/订阅/publish/cleanup验证，#1505当前实际source/SMOKE段20:04:10–22:04:10，本方未占生产窗口。

### 历史测量和最终生产边界

历史隔离故意失败实际源为1d126/run42552094175：20完整trace/80span/40ERROR，两轮后端快照稳定，17条起初未被head采样选中。历史Web内存exporter基线mean **+0.344583ms**、p95 **+0.436580ms**（每条件600次、100预热、分组交替），保留原测量范围；不称84ce生产或全部daemon成本。关键依赖比较及serverless新增drain分支边界见CP43，不重复一个覆盖不到该分支的相同probe。

NewTask UI的一次点击已源级确认进入真实Coordinator消息/turn；最终仍须两条官方模型用例的同trace父树、每次AI调用、Logs、实际Replay播放、native PNG和已填真实ID的timeline。Factory task UUID与carrier的issue ID不可混用；reconciler的sets_consistent不代替这些人工判断。warm-up/user/action告警规则已有实际配置回读，不另造告警或新OAuth门槛。

## 上一轮 e093：完整 Native 预算 RED（历史记录）

该轮固定 feature **e0934eb89f972d44ef6cffec6e27c16b4ed203bf**，实际 CI checkout **114d370f807c465c0f6fe1be47e941aa19adf62a**，共同 tree **0a0e2a40d82cbcb18963584e7d54f834a3af54fb**。完整原件与独立复算见 [CP42](https://github.com/alexj11324/Mikka/tree/a995674f93b90ee0110dce9bdb71348cb0019647/docs/operations/evidence/1512-raw/gate-completion-e0934e-20261109)：54 payload / 8,355,283 B，加README/index共56文件，普通单父提交及所有path/mode/blob已回读。

**#1512 新正式生产验收仍为0/2，issue保持OPEN。本PR不自动关闭issue。** Native功能作业和strict的成功不能代替下面的实际预算。

| 原始窗口 | Native | Web / Hosted | 本轮结果 |
| --- | ---: | ---: | --- |
| 完整email/auth/PKCE/navigation/background窗口 | **451=19+15+417** | **427=19+0+408** | **RED，+24** |
| 原FIRST pair1 | 205 | 207 | 通过，完整预算仍失败 |

Root与独立checker复算24 records/12 checkpoints/8 segments/2280桶/1290连续ordinal，守恒无错误。unknown与所有后台流量完整保留；Hosted FIRST的chat跨原end227ms，不加回、不延窗、不换pair。相对6414，FIRST Native仅−4、Hosted+60；不把对照窗口变化说成代码收益。

### 已定位的真实读路径

第三次 `bots.pollBots` 有28条SQL，另三次各2条；额外26对应现有Coordinator旧聊天回填路径。18个known结构与固定源码逐literal哈希对应，8个unknown不补造。Native其余contexts合计−8（issues−3、task-runs−3、chat−1、summaries−1）；Web chat policy−4。C两条列表的实际调用数没有减少，定向测试通过不扩成已观测节约。

API年龄与既有10分钟回填周期相符，原件未记录实际缓存时间或每个UPDATE的rowCount。正在实现的最小修复把保守legacy存在性判断并入已有active Personal查询；只有当前Coordinator存在且严格false才跳过空事务，缺目标/权限不足/未知/有旧数据都保留原创建、锁和迁移。原TTL、失败重试、晚到旧行下一pass语义不变。候选尚未发布，真实PG回归尚未取得，反事实减少不当作实际Native通过。

### 本轮已完成的门禁

- 主CI42678180995/A1与最终strict自然结束，7个selected gates实际true/success。
- Source361/361；Core57 targets、A22和driver74逐名通过，未使用Nx缓存。
- Integration29 targets；完整Live三文件104/104、0fail/cancel/skip，新C7和末尾真实404降级均执行。
- PG3/4=18 suites/1673 tests，B23逐名通过；PG4/4=18 suites/685 tests，新增真实授权revision3次→1次且结果不变。仅这两片原件计数，不冒充全部4片总数。
- 全头10 workflows=9success+1failure；40 jobs=31success+8skip+1failure；41 checks=32success+8skip+1failure。Root逐ID核run/job/check/suite，无缺口。
- **本头E2B42678181268/A1仍真实失败：211=210PASS+1FAIL**，旧Codex0644→0777负例失配，后续Python/shell均skip。后来a83绿色不替换这个结果。
- 旧手动完整Live未取到终态仍UNKNOWN；此前A/B/C RED→GREEN见[CP41](https://github.com/alexj11324/Mikka/blob/7526d0f057dffa172d90c102eaacce7bac49dcad/docs/operations/evidence/1512-raw/native-read-corrections-20261109/index.safe.json)。旧6414与6cc各自原结果也保持来源不变。

### 来源、后续发布与资源

18:54:01只正常CAS自有feature；历史为6414→自有10文件e7dfd5→正常merge实际main d8所得272d578→正常预合#1835 cb2所得e093。独立6820叶一致。journal、trace/Replay、Native harness/原窗口/计数/阈值与100755 fixtures保持原字节。

#1835固定a83的六workflow已全部成功，但19:44 fresh仍OPEN/unmerged，须原owner正常落地。其三文件publisher类型合同修复已准备普通merge b1ce3e10fe5c5ae95584e6bcbc6008462593ef39/tree d1360fae，**保持未发布**；先修实际Native读路径，不借不影响应用的改动抽一轮绿色。后续源码/PG/Native都绑定真正新修复。

19:44 main仍d8。#1503实际source+SMOKE段19:12:47–20:42:47正在按失败实际scope清理，尚未等同明确释放；#1505后续准备不是未来预约。主线/生产发布前fresh核实际owner及队列。有效旧云runtime仍不能证明所需daemon修复已发布；Native daemon0.0.564/8db与云worker分列，不设置AppSHA必须等于RuntimeSHA的伪门禁。

取证VM实际171893ms后stop/delete/exactGET404，自有资源0，费用金额unknown。生命周期workspaceNameCleanup保持phase=unchanged/restored=false，与owner/peer sealed-baseline before=false/after=true和parity restored=true分别保留。每个原log/ZIP一位reader、一次原读取，复核复用Git原件。

## 上一轮 6414：功能 CI 绿色，Native 预算失败（历史记录）



固定 head **6414a08ddb4a92962bc82e9e427c391d645cacb2** / tree **05b40c13c233d7f3cef989011705cf624b27c507**，实际 checkout **576c903cd6ede14520a79111d2b71154968ad910**。本轮 [42663994959/A1](https://github.com/alexj11324/Mikka/actions/runs/42663994959) 及伴随工作流已自然结束：9 workflows success，38 Actions jobs=31 success/7 原条件 skip；加 GitGuardian 后39 checks=32 success/7 skip。Core57 targets/driver74、Source361、Integration29、PR E2B官方文件34均成功，strict成功。没有重试或改变期限。

**功能 CI 绿色不代表 #1512 的 Native 预算通过。** 唯一读取者提取并冻结本轮原件后，root 从原 JSON 独立复算，24记录/12checkpoint/8段/2280桶值/1220ordinal守恒，恰有两项预算失败：

| 原始窗口 | Native | Web / Hosted | 结果 |
|---|---:|---:|---|
| 完整 auth/email/PKCE/navigation/background 窗口 | **433=19+15+399** | **431=19+0+412** | **RED，+2** |
| 原 FIRST startup pair 1 | **209** | **147** | **RED，+62** |

unknown、后台流量和原窗口全部保留。上一6cc首对为213/220；本轮Native实际减少4，Hosted减少73，不能写成Native增加62。Hosted首对4个RPC跨原结束边界，实际完成晚23/33/98/144ms；仍保留147，不能补算尾部、延窗或换首对。daemon也从562/111a变为564/8db，不把全部变化归给App两文件。

完整Native新增8条都在workspace段。已定位三种真实查询结构：拆成独立HTTP的summary/chat各重复读取新鲜membership choices（+2）；独立chat失去原批内policy memo、同次读取内subscription policy由1→2（+1）；revision结构增加2但未记录参数，不能认定相同refs重复；剩余3条unknown继续保留。后续仅修可证明的正常读取内去重与已授权Team闭集revision计划，不跨请求缓存权限，不改变401/response proof或测量合同。真实批内结果交付等待也已确认，但逐项stream会涉及整批401，暂不以传输拆批或推迟工作求绿。

不可变原件索引 blob：`c69fc099057761c44bd70401d264f1d422e06e21`；差分proof `c5e8690b7774a2e2fba4332d3aad22f9d8872df7`；源码诊断 `886c194df4b3df8a724efd09bd5489dfcb74c590`。已归档 [CP40](https://github.com/alexj11324/Mikka/blob/96ead08d787a15e14bcbd552138d09892dd11caf/docs/operations/evidence/1512-raw/gate-completion-6414a0-20261109/index.safe.json)：46 payload / 4,459,802 B，另含README/index；48文件全部远端SHA-256/Git blob逐字复核，历史CP39不重写。提取VM已stop/delete，精确GET404，剩余0；没有生产模型任务。

共享运行时仍受5ba实际R7的Codex CA mode/Desktop apt备份守恒失败阻塞。#1505 owner负责唯一官方Codex/Desktop控制，本方复用安全投影，不重复创建实验或读取其原log/ZIP。#1835 Claude规则已有真实独立控制及严格RED/GREEN；须原owner先正常落地。当前本方不持source/账号窗口，issue保持open。

### Claude 规则证据与严格边界

原owner的唯一官方Claude控制 [42661569263/A1](https://github.com/alexj11324/Mikka/actions/runs/42661569263) 已自然完成，公开实际tuple及精确清理见 [#1724/6746475919](https://github.com/alexj11324/Mikka/issues/1724#issuecomment-6746475919)。before/pre_finalization/ready两个CA为4e04…普通文件，fresh是精确两条链接；三路径四阶段0777、0/0，root保持普通文件并在fresh更新，两链精确解析到当次root。本方已读Git原JSON并独立核验12节点/8链与两份精确清理，按原JSON文本保留全部大整数并复原两个member，bytes/SHA与原artifact完全相同；proof0630402e。没有重复创建control或下载原ZIP/log。未采base/build/envd身份保持unknown；该实验不是R7同build证明。

#1835 fixed37fb的原320规则和matcher原字节不变，仅追加两条Claude摘要/target范围，finalization只更新对应pin。原29方法保留，诚实维护其中一个旧“正确Claude形状拒绝”的参数为错误旧摘要拒绝，另加5方法。已独立读取现成[RED/GREEN Git归档](https://github.com/alexj11324/Mikka/tree/800eff40eeead9c78fb83cd2260adc0cf40fbd4f/claude-ca-relink-candidate-20261109)：RED实际34方法、原29 PASS、新正例2 ERROR及6子项FAIL；GREEN实际34/34无skip。那6子项是旧策略更早拒绝导致错误码不同，**不表示旧策略放过了不安全终点**。严格安装、未列路径、CLI、uid/gid/mode、root类型/终点、receipt-kind及安装proof替换拒绝均保留。

固定37fb时，预期共享主线与6414的480项worker输入精确一致，manifest摘要c179aa19…仅是输入集校验。最新8197只追加控制证据/ADR和supplementalControls指针，授权rules不变；但完整policy bytes参加policySha256/canonical recipe，因此该metadata更新仍改变哈希，不冒称与6414全部输入仍相同。后续若#1835只补ADR，按真实diff核其与构建/测试输入的关系；若改实质源码则重新验证。此前#1834和#1506实际窗口均已于17:50释放；#1834的Web部署已READY。该main5ba自动R7 42661874195/A1已于17:23:13失败并由owner精确清理，本次是Codex rootCA0644→0777与Desktop apt备份SHA变化，具体phase/完整前提仍待读原owner安全投影。Claude控制不扩大到这些项，#1505 owner已负责唯一Codex/Desktop官方控制，本方只复用其原件安全投影，没有重复控制，也没有进入source/Smoke窗口。

## 上一固定源码 6cc：全部门禁通过；生产验收仍为 0

关联 #1512；**本 PR 不自动关闭 issue。当前没有本方生产模型消费者或临时 VM。**

上一已验证 head **6cc38aca620d16b25eebe0c8787747885a2cceb1**，tree **9628e365dede1eaf6b45bab3ad35dfce11fbdace**。16:16:22 UTC 正常 CAS 更新自有 feature，未移动 main。它是普通 merge commit，有序 parents=[**932bd1549942bc2a8d040c7281a37fbe851c8eb0**, **8c423db291f8121980267cd48a24e428c992f618**]，完整保留 #1810 当前联合修复的历史；#1810 已由原 owner 于16:34:17正常合入 main 8db16095f46be955df22f42914e0f89b6e5f3d11，正式 R7 42656120803/A1 于16:47:38失败，原因是 Claude fresh 证书 file→symlink 未有该模板的完整控制证据。

Root 独立重建 Git tree 并回读远端 **6805 个 leaf，0 缺失、0 mode/type/blob 差异**。相对 932 仅42个上游路径；3处双方改动分别保留：自身 package.json 的双方测试命令、包含 masked Replay/SDK browser 保护的 analytics-policy 测试，以及上游完整 Desktop 安装保护的 pinned-pnpm 测试。恢复 journal 三文件、成本文档、Replay 实现和两个100755 daemon fixture逐字不变。

6cc [CI42653081708/1](https://github.com/alexj11324/Mikka/actions/runs/42653081708) 已于16:46:13自然闭合：**15/15 workflow success；50个唯一Actions job为40 success/10原条件skip，另1个GitGuardian success**，全部attempt1，无重试。Core实际57 targets/driver74 PASS；Source361/361；Integration原29 targets自然成功，team-import14641.96102ms仍在原15秒期限内；strict七组期待和实际均success。各原log/ZIP只有唯一reader，root复核复用Git blobs。完整原件见 [CP38](https://github.com/alexj11324/Mikka/blob/8eb9564e2b5f03a4d7901f29f0f42b0327e18982/docs/operations/evidence/1512-raw/gate-completion-6cc38a-20261109/index.safe.json)。

6cc 原 Native 实际 checkout16dcb17/tree9628，原完整登录 **425=19+15+391≤435=19+0+416**；原FIRST pair **213≤220**。Root从五份原JSON复算24记录/12checkpoint/8段/2280桶值/1293ordinal，错误0；unknown和后台流量未扣，细归因仍incomplete。lifecycle restored=false、sealed before=false/after=true，smoke/parity restored=true分别保留。五对时延Native中位2618.43ms、Hosted2218.84ms，Native慢约400ms；原合同没有时延阈值。取证VM已stop/delete并精确GET404，剩余0；费用unknown。Root未查看parity PNG像素。

### 运行时来源与发布次序

已核已公布有效 runtime **Rfacb/Wa453** 与实际main e189/932的相关源码。旧R缺少合法 aborted/无usage generation终态、host-bound MCP traceparent、工具单调时长与parked Codex startup recorder修复。cloud worker的hosted-subscriptions/e2b模式不通过新版npm自动升级；Native实际安装111a/0.0.562不能作为E2B运行该版本的证明。当前host有受控固定R/W刷新路径，但须有实际成功回执。

实际8db的tree18b539与预先核验完全一致；其下本方新合并预览0bb80be7仍为tree9628，与本次实际CI checkout16dcb17整树相同，不为此追加push或CI。8c已包含所需daemon源码，并加入私有worker-install、严格工具执行证明以及已证Claude目录/Desktop精确证书relink规则。Codex历史0644→0777仍被拒绝、原因仍未证明；没有新增mode例外。本轮实际 R7 中 Desktop/Codex 到达fresh_receipt，Claude两条CA file→symlink被严格守恒拒绝；subscriptions/await-web/publish均跳过，三候选删除与空sandboxes/errors由原owner唯一读取cleanup原件确认。完整Claude mode/uid/gid/root仍unknown，现有Desktop规则不会直接扩给Claude；正在准备一次固定源码、单模板/单VM、有绝对期限的Claude独立控制。此处当前尚未激活control，没有同版本R7重试或policy放宽。新模板仍须正常完整保全和真实双订阅后发布。**不增加 AppSHA == RuntimeSHA 条件**；本次任务实际worker与真实trace才是验收证据。共享发布若实际完成可复用其固定runtime，本方不另建相同代码模板。

#1827已由原owner于15:42正常merge为main e189；Factory前一窗口已实际释放。此PR此前的下一≤90分钟计划从未进入、没有持source或账号，现在按实际发布writer、源窗口及最终worker就绪接续。对 #1810 的正常预合并只发生在自有feature，不提前落其PR。

### 已完成的历史门禁

932的 [CI42637270671](https://github.com/alexj11324/Mikka/actions/runs/42637270671) attempt2于15:22:44成功，14个当时workflow全部成功；有效Actions为36 success/10原条件skip，另1个GitGuardian成功。历史69条checks仍保留56 success/2 failure/11 skip。

原Integration在未改源码的team-import子进程15秒超时。Root与独立reviewer先完成固定ref、Node/镜像与计算/等待耗时核对，才在Native完成且临时VM停删404后请求一次有据重复。实际只新执行Integration及自动strict，29原targets不变，team-import在8876.366829ms完成实际26导入/24模块/22场景；没有重复Native。具体原超时phase/CPU原因仍unknown。

932原Native完整窗口 **433≤435、原FIRST pair209≤234**；email、PKCE、navigation和背景原窗均保留，diagnostics仍incomplete且unknown未扣除。lifecycle restored=false、smoke/parity=true分别保留；冷启动中位bundled2194.50ms/hosted2129.91ms，不声称更快。它的actual checkout86f8/tree3c0只属于932；新的Native helper源码组合由6cc自己的CI验证。

完整原件与失败边界见 [CP36](https://github.com/alexj11324/Mikka/blob/5429efb005f91355dc8251ea118835cebb2be31d/docs/operations/evidence/1512-raw/gate-completion-932bd154-20261109/index.safe.json)；历史来源发表与初始失败见 [CP35](https://github.com/alexj11324/Mikka/blob/e33e458fc389de82dee197919284162e7aed8308/docs/operations/evidence/1512-raw/source-ci-932bd154-20261109/index.safe.json)。


本次完整源码合流、runtime缺口、480项构建输入等同性及现有任务绑定推断的边界已收于 [CP37](https://github.com/alexj11324/Mikka/blob/5946460519abf382360a5ef9a18a560f1c859093/docs/operations/evidence/1512-raw/runtime-source-and-union-20261109/index.safe.json)。所有条件/实际状态分别标注，未将source证明写作runtime发布成功。

## 问题与修改后的行为

实际发布和取证暴露了几个相互关联的问题：tracked daemon fixture权限不稳定、serverless返回时仍有在途遥测未收尾、返回式工具错误未正确保留ERROR，以及Native完整窗口SQL超预算。生产验收准备还发现原模型/绑定的恢复依据只存于进程内存，失败退出后无法继续核对。原始失败和未知都保留在证据中。

- **调用链收尾和错误：** root-span的waitUntil覆盖batch队列与已开始的exporter transport，Logs并行flush；响应不等待遥测。工具拒绝保留子span、ERROR与闭集code，不改变业务返回或授权。
- **Native与SQL：** snapshot读取使用可撤销的本地发送提示等待在途读取，仍要求实际response proof、SWR commit、scope和revision；无新增timer、产品SQL或轮询。保持后台fresh policy、原子enrollment、command snapshot、runs/repos的新鲜授权与撤权回归。
- **模型和发布关联：** 保留daemon generation、W3C carrier和metadata-only合同，复用已授权最小Codex MCP reader/producer/writer回归。E2B诊断只输出闭集关联字段，HTTP trace仅表示提交请求。
- **安装器凭据：** 默认空的显式输入覆盖环境继承，既有16个只读调用明确opt-in、两个写权限调用匿名；保留完整性和30秒/3重定向限制。
- **生产验收driver：** Factory read/write/cleanup固定已核Personal selector，拒绝冲突selector；有界owner-idle检查保留。只有精确HTTP404加agentProfileNotFound能判缺失，权限/未知代码/坏JSON不能被写成清理成功。
- **恢复记录：** CLI在任何新配置修改前先持久化最小recovery.json，收到实际implicit bindingId/revision后立即保存。配置已确认而checkpoint随后失败时，仍执行原有安全清理，并阻止下一case；不削弱ownRunsStopped、ownerIdle、版本/摘要、值比较或implicit CAS。独立文件0600、fsync和atomic rename；always artifact清单只增精确文件名。
- **费用语义：** 文档明确区分Gateway返回的逐次金额、ZeroCat按配置token价计算的估算，以及未知费用。passthrough本身不证明实际订阅扣款；没有改计费代码、历史数据或冻结查询。

journal只保存经过校验的模型id/kind/modelId/provider/chosen、实际绑定版本、profile id/version/digest/enabled和闭集状态。profile定义正文、消息、凭据、cookie、label、quota均不落盘。响应丢失/SIGKILL仍可能只留下未确认intent，不能猜恢复；固定文件不是跨执行历史数据库，现有非CAS picker/fallback边界仍保留。

上游Workspace身份、fresh lease、PAT/跨tenant和迁移保护完整保留。移动端设计仅保留原UI owner的固定源码与原截图审阅；没有新增本方UI设计。

## 验证与原始证据

| 证据 | 实际结果 | 适用边界 |
| --- | --- | --- |
| 恢复journal首次RED | 旧driver + 新10组行为测试：原63 PASS、新10 FAIL；完整stdout保留 | 最初子进程exit code未独立保存，明确unknown；不是缺少export造成的假RED |
| shared真实schema反例 | 共享API key是kind shared + apikey:UUID:model；旧候选专项1 FAIL，真实exit1 | v1的73/73不被追认为最终通过；错配和修复独立留档 |
| 精确最终driver | **Node v24.22.1，74/74 PASS、0 skip、exit0** | driver104075571c73b97a985458f206dba310e4894490 / test2e3c8c7aad0594df165caf8f798c72034b3d484f / workflowebbf83b8d39c5471f9daaf0ed9bf0dfa758214e4；是隔离HTTP fixture/真实CLI离线测试，不是生产 |
| 字节与独审 | 原81045B测试完整连续保留；旧63名字在最终输出各出现一次；八份执行源码hash一致；实际Git正反应用及Root独立重放一致 | 不以静态test声明数冒充执行数；独审修正shared格式并保留较窄安全identifier语法边界 |
| 历史932联合CI | 主CI attempt2于15:22:44成功，14当前workflow成功；Core实际driver74/74，Source361/361；最终有效Actions36成功/10条件skip | 原A1 Integration/strict失败完整保留，唯一有据重复仅执行Integration及自动strict；实际checkout86f8/tree3c0；CP36 |
| f346历史完整CI | [42621847483](https://github.com/alexj11324/Mikka/actions/runs/42621847483)于13:34:16成功；14workflow、主22job、当次51checks按原条件闭合 | actual checkout3b51cf11/tree102bc；只属于旧f346，不属于932 |
| f346历史完整Native | 全窗口**431=21+15+395≤444=19+0+425**；原FIRST pair**211≤228**。Root核2280桶值、1314ordinal，无算术差异 | daemon0.0.562/111a；diagnostics仍incomplete，unknown未扣除。lifecycle/smoke restored=false、parity=true；Root未查看parity PNG。本轮932另有自己的完整原窗与CP36，不以此历史结果替代 |
| 历史受控失败/开销 | 旧main1d126的20trace/80span/40ERROR日志完整读回，handler mean+0.345ms、p95+0.437ms | 历史基线；最终实际发布源仍需原定20受控失败与600配对样本/100warmup |

恢复journal唯一VM为1vCPU/2GiB，无账号/模型/数据库/依赖安装；实际14:15:04.275—14:27:42.881 UTC，758606ms、active CPU16360ms。已stop/delete，同project/name、resume=false精确GET404，**本方该步骤活动资源0**。实际美元费用没有返回，保持unknown。

主要证据入口：

- [CP39：6414正常合流、Claude官方原件/Root逐字复核、共享RED/GREEN与新R7 writer边界](https://github.com/alexj11324/Mikka/blob/bfa05daedfdbcd65433a5cabbd3e415c9707bb16/docs/operations/evidence/1512-raw/claude-control-and-6414-union-20261109/index.safe.json)：13 payload /135,016 B，index5,654 B；当时Native/strict仍运行，生产0/2。

- [CP38：6cc实际完整CI、Native原件、Root独立复算和本轮Claude R7失败边界](https://github.com/alexj11324/Mikka/blob/8eb9564e2b5f03a4d7901f29f0f42b0327e18982/docs/operations/evidence/1512-raw/gate-completion-6cc38a-20261109/index.safe.json)：47 payload /5,029,007 B，index16,148 B；实际checkout16dcb17/tree9628，无重试，临时取证VM已精确停删404。

- [CP36：932最终CI、Native全部原件、一次有据重复与历史映射](https://github.com/alexj11324/Mikka/blob/5429efb005f91355dc8251ea118835cebb2be31d/docs/operations/evidence/1512-raw/gate-completion-932bd154-20261109/index.safe.json)：40 payload /2,685,168 B，index12,911 B；旧RED、未知与资源404均保留。
- [CP35：932源码发表、6795leaf、初始CI及超时对照](https://github.com/alexj11324/Mikka/blob/e33e458fc389de82dee197919284162e7aed8308/docs/operations/evidence/1512-raw/source-ci-932bd154-20261109/index.safe.json)：25 payload /5,478,650 B，index8,568 B。
- [CP34：恢复journal原始RED/GREEN、精确源码、独审、资源关闭及费用语义](https://github.com/alexj11324/Mikka/blob/22c873a4882140c361dc48abd424fb5e5087eac0/docs/operations/evidence/1512-raw/recovery-journal-20261109/index.safe.json)：38 payload / 1,636,898 B，index12,514 B；timestamp在932发布前，因此如实记sourcePublished=false。
- [CP33：f346 reopened完整CI、Native原件及Root核算](https://github.com/alexj11324/Mikka/blob/fbb00e5e7f8aa134900dac86e9922b77855fa5a3/docs/operations/evidence/1512-raw/reopened-f3466ba-20261109/index.safe.json)：36 payload / 2,478,315 B。
- [CP32：PNG/Replay执行合同与旧P0条件证明](https://github.com/alexj11324/Mikka/blob/d0395e6283a51a9e80ecf46e4d0b53894502a038/docs/operations/evidence/1512-raw/production-readiness-contracts-20261109/index.safe.json)：合同不等于生产证据。
- [CP31：f346第一轮CI/Native、scouts/billing及CP29归属更正](https://github.com/alexj11324/Mikka/blob/5f6872c8b708a5176e99086321606e28930db401/docs/operations/evidence/1512-raw/readiness-f3466ba-20261109/index.safe.json)。
- [CP29：ae10完整历史原件](https://github.com/alexj11324/Mikka/blob/df0d632f4108f2f81a9a8db0e0e64ed099d25f99/docs/operations/evidence/1512-raw/complete-ae10f28-20261109/index.safe.json)和[CP27：安装器、driver及原始失败](https://github.com/alexj11324/Mikka/blob/6dcc538786da81cdcce85aa7139f4b3faaa2cc4d/docs/operations/evidence/1512-raw/prepared-corrections-20261109/index.safe.json)。

更早候选、首次完整Native窗口、原失败、误关重开及所有资源回执仍在同一证据分支历史/issue进度。CP29曾将Source的迁移63项误注为driver；更正已明确driver实际在Core129114784847的test:dev-local，见[原更正](https://github.com/alexj11324/Mikka/pull/1799#issuecomment-6739435139)。

## 完成前的实际门禁

1. 6cc完整CI与Native原窗已封存CP38；当前6414功能CI已闭合，但原Native两项预算RED；完成正常读取内的具体修复和其原窗验证后才具备合并条件。核原owner官方Claude控制Git原件，接入#1835最终ADR及owner正常落地；合前鲜读main/head/实际publisher。实质源码变化再核受影响门禁，不用旧绿覆盖新差异。
2. #1810已由原owner普通merge为8db；继续核其共享runtime正常发布及清理。本方只在自身门禁通过、真实窗口可进入且相关发布writer已终态时，自行普通merge #1799。
3. 核本方Web READY和生产公开版本，再用原授权ACME账号的Personal路径执行独立Claude Haiku5.5、GPT-6 Luna真实订阅案例。分别记录App、实际有效runtime和本次任务worker来源；不要求App SHA等于runtime SHA。
4. 收齐真实run/thread/task对应trace的全部分页、每generation/APM集合、错误和日志、原生PostHog PNG像素及实际Replay渲染，并证明运行时间线入口可用。
5. 最终发布源的受控失败保留、实测异步开销、scout开启、费用与用量、资源关闭记录齐全后，手动关闭#1512。缺失和未知始终如实保留。

## 合并风险

**Merge risk: medium**

**Alignment: good ✅** — 修复#1512在实际发布/验收中暴露的缺口；恢复记录补齐已观察到的清理依据遗失。Native固定源码作为明确上游预合流保留，不代替其owner验收。

**Impact: large ⚠️** — 既有PR涉及tracing结束、设备/Workspace读取边界、安装器与真实生产验收。恢复journal自身仅影响运维driver；敏感字段投影、checkpoint次序与旧并发保护已有直接反例和审阅。

**Verification: blocked** — 当前6414的9条workflow全部成功，但Native原完整窗口433>431、原FIRST209>147，均RED；完整原件与root独立复算见CP40。6cc及更早通过只属于各自历史源码。正式R7、生产摄入、PNG/Replay及实际任务仍未完成；功能CI不替代这些验收。

**Rollback cost: medium 👀** — 源码可通过正常revert PR回退；真实任务/临时设置须按原guard独立清理。journal不能覆盖并发修改、恢复未知回执或保证已销毁runner上传。

**Error detection: decent 👀** — 已有返回式ERROR、in-flight flush、权限404和恢复失败负例，错误保持闭集name/code；实际PostHog链路仍以生产原件判断。

## 可观测性用量与费用（2026-11-09 更新）

截至 **2026-11-09 11:47—11:49 UTC**，官方只读回执确认：项目 `670821` 在 **2026-10-17—11-09 UTC 日级窗口**的 Logs + Tracing **373 MB**（其中独立分项APM324MB、Logs47MB；与组合项差2MB仍unknown）、AI Observability **857 events**、Web Replay **16 recordings**。Root独立复算5×24日桶、next=null；末日0不证明当日没有摄入，且这些计量不证明本issue案例通过或Replay已播放。

组织级本账期另报 **Logs447MB / AI1117events / Replay18recordings**，与项目口径差额未知，不混算。组织仍为 **free**、无active subscription，cap为 **10,000MB / 100,000events / 5,000recordings**，均未超限；账期 **2026-10-17 17:45:01.620—11-16 17:45:01.620 UTC**。美元字段为null，实际美元费用保留 **unknown**，不能称$0。本次没有修改plan/cap/retention。

APM/AI两个scout均enabled/active/emit=true、间隔1440分钟、Inbox开启且无Slack/Webhook、连续失败0；今日2/100次、余98。last_run_at为06:30/07:30，只是metadata，未独立证明报告已完成；下一次精确运行时间未知。

当前官方价格：Logs/Tracing 共享每月10 GB免费，超出后10–300 GB档 **$0.25/GB**、300 GB以上 **$0.15/GB**；AI每月10万事件免费，首个付费档 **$0.000350/event**；Web Replay每月5,000条免费，首个付费档 **$0.0050/recording**。来源：[Logs/Tracing](https://posthog.com/logs/pricing)、[AI](https://posthog.com/ai-observability/pricing)、[Replay](https://posthog.com/session-replay/pricing)。

官方MCP文档本次明确确认：所有 `$ai_` 事件按AI Observability计费，**不再按Product Analytics重复计费**；额外 `$ai_span`/`$ai_trace` 仍是AI事件。一次成功的标准Replay Vision observation为5credits，两session各一次的名义估算10credits/$0.10尚未扣免费额度，也不是已发生费用。Scouts每次调度的固定单价未证实；Self-driving公开价按符合条件的PR结果计费（每月前三免费，随后$15/PR），不能乘巡检次数。当前free计划超额度可能停止摄入/扫描，不等于自动购买付费超额；OTLP/JSON传输bytes也不能直接当账单存储GB。规则与公式见CP33补充，以及[AI事件类别](https://posthog.com/docs/ai-observability/basics#the-ai_-prefix)、[Vision额度](https://posthog.com/docs/replay-vision/quota-and-limits#workflow-scan-limits)、[Self-driving定价](https://posthog.com/docs/self-driving/pricing)。

容量估算沿用文档的明确假设：以2026-11-05报告的 **73 MB traces/day** 为旧基线，30天为2.19 GB；若其中10%所代表的既有流量由10%采样改为全量，且流量和每条大小不变，再假设100 runs/day、每run新增25 spans＋10 logs、每条1 KB，则约 **4.27 GB/月**。若该既有流量全部改为全量，则为 **21.9 GB/月（未含新增遥测）**，按公开付费档折合摄入费约 **$2.98/月**；这是场景计算，不是实际需求、当前账单或提额授权。同样，100 runs/day×5次generation仅为 **15,000 generation events/月**，额外 `$ai_*` 事件另计；100条Web录制/day为 **3,000 recordings/月**。PostHog的事件/摄入费与模型提供商费用分开，订阅模式缺少单次收费回执时保留 **unknown**，不以API目录价或零值冒充实际订阅逐次账单。

