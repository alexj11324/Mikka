# CP57 — Native 实际读取因果、原件恢复与 PostHog 准备状态

截至 2026-11-10 05:26 UTC，正式 PR #1799 仍在 `5f3598029033b83ee72c88ea6c49955205eecab2`。正式完整登录 **Native 441 > Web 331（FAIL +110）**，生产正式案例 **0/2**，#1512 保持开放。

## 原始结果与来源

| 版本与原始窗口 | Native / bundled SQL | Web / hosted SQL | 判定 |
|---|---:|---:|---|
| 正式 H：完整登录 | 441 | 331 | FAIL |
| 正式 H：原第一组启动 | 208 | 228 | PASS，仅此窗口 |
| 临时诊断：完整登录 | 441 | 365 | FAIL，不能替代正式验收 |
| 临时诊断：原第一组启动 | 209 | 218 | PASS，仅诊断窗口 |

临时诊断源码 `2e2f75de15a01858ac0990bbcf4b50156832dbc7`，tree `23179d928269195860beaf27ad27786c7f5e7637`，单父为正式 H。原 Actions run `42757687653/A1`、job `129635774633` 的30个步骤全部成功；实际 Node 24.22.2，诊断协议与入口65/65通过。插桩代码、原窗口逐字守恒及入场关闭证据在前一 CP56。

五份精确 JSON、两份原 ZIP、原日志、完整 SQL/RPC 复算以及闭集因果分析器均保存在本目录的 [native](native/index.json) 下。24条SQL记录、12个checkpoint、8段、2280个桶值、1233个连续ordinal全部守恒。全部unknown、后台调用及Native PKCE成本保留，0 uncaptured/drop/overflow。RPC八个原投影完整，无跨窗、缺失开始/完成或孤立完成；RPC不能代替SQL计数。

## 提取失败与恢复均保留

首次提取 `42759926625/A1` 在原件已经下载、校验并Git冻结之后，因 lifecycle.json **2,814,247B** 超过旧2MiB单成员上限而失败。失败receipt、完整原log、旧controller和manifest原样保存，未将它改记成功。

两个原artifact各只执行一次API GET和一次delivery GET。恢复 `42760736569/A1` 仅读取已经冻结的Git ZIP `c49a4729...` 与 `5d50ea60...`，不含artifact下载路径；核对原ZIP长度、SHA256、Git SHA1，Native全部314成员的精确中央目录元数据、三个JSON精确长度/CRC，package两个JSON的原审计长度/SHA256。全部316成员CRC通过，五JSON均在解析前冻结。两个提取任务的private directory均已删除，入口均关闭；恢复closure `42760843495/A1` 实际SKIPPED、无runner/steps。原件已归档在closed ops commit `a4f88bb178f893eee979bdf3f34262e0f8f661c5`，本检查点引用完全相同blob。

## 已证明的客户端因果及其边界

14份诊断记录中13份完整。Native authenticated-profile含三个完整realm（初始未登录文档5行、认证文档365行、当前文档354行），没有丢行或溢出。**普通Web登录首文档未捕获**：该记录expectedDocuments=2、实际1个realm、reason11；不能推断缺失文档没有连接或补读。

[独立快照因果审查](causal/independent-snapshot-review.json)直接从原tuple重建read/action/request/dispatch proof与fresh分支。Native两个认证文档中，五个已审计snapshot family各有首次读取和一次catch-up，10个first→second对的首次真实dispatch均早于相关socket open/late-subscribe义务；收到结果晚于open也仍携带旧proof14/23。它们走现有F3补读，没有F2“捕获但未派发”或F5“pending dispatch在新边界之后”。重复F行并不等于重复RPC。分析器全部20个realm没有内部关联错误或unresolved association，但这不补齐缺失的Web文档。

Native的三个delta同步family也保留原新鲜度判定；不能把它们整体加入snapshot白名单或用完成时间替代dispatch。当前数据支持研究：在成功Bootstrap解析/校验及generation检查之后，让同一个实际需要的LiveChannels连接与已有工作区初始化并行，后续真实订阅接入同实例。该产品修复尚在准备，**没有声称提前连接已经有效或预算已经通过**。

E14只记录HTTP response status，之后仍有response.json、decode、readBootstrap校验。status到首次read的525/1874ms观测间距不是已测定的可用提前量。Native launch在登录窗口开始前，profile dump在窗口后的device preparation之后；整realm前缀不等于SQL窗口。没有按相近时间连接renderer readId与SQL ordinal。

## 清理及资源

lifecycle六个cleanup阶段均passed，nativeCleaned=true，lease released，owner/peer sealed baselineAfter均匹配；workspaceNameCleanup.restored=false等原字段不改写。package/crypto原件证明三个独立加密进程退出，parity原件保留完整102屏结果。Mac PostgreSQL stop步骤成功，但没有独立“服务已停止”输出，未将步骤状态扩写为观察到的服务停机证明。GitHub任务已终态；本方独立VM为0，没有生产账号或模型动作。

## PostHog 只读准备刷新

[元数据摘要](posthog/preparation-status.json)观察于05:05:49–05:09:06 UTC，按实例skill/knowledge流程只读六个元数据对象。APM与AI两个Scout均enabled/active、Inbox输出开启、1440分钟周期、连续失败0。Notebook C9vQAc1L存在且未删除；本次接口未提供version/runtime，因此不重新确认v15或stopped。Insight13703263/k3M88Rs8存在，告警enabled/Not firing；原24个合格历史小时、绝对量与倍数阈值、95%字节覆盖等静态定义保留。

组织级billing overview返回Logs373/10000MB、AI857/100000events、Replay16/5000、Vision0/2500credits、Signals0/4500。这些不是project670821专属用量，精确账期和费用unknown，limit不解释为剩余额度或硬上限。本次没有触发Scout/Vision/Notebook、没有真实事件查询或PostHog对象修改，不能代替生产验收。

## 最新主干的未发布合流准备

实际main已由原owner把PR1860合入 `ab2d00a43a79d35380b4d2db9014a3792fea63ca`。本方准备了普通双亲merge对象 `9238b7092a39fce7edde2e488aef516c0b544677`，parents为[H,ab2]，tree `03712f2c1ca03ee45e61e124bd430fc9d1a377c9`，全部6978叶与预期相同，**未移动正式或main ref**。新main四条路径中两个validator重叠为不交叉的增量：本方startupCorrelation与上游liveObserver及其全部测试都保留。组合源码的针对性Node测试仍待下一必要验证，不转记单边旧测试为合流通过。证据见 [main-integration/proof.json](main-integration/proof.json)。

本方继续处理真实Native读取缺口、正式组合源门禁和实际生产双订阅/APM/AI/Logs/Replay/截图验收，完成后才关闭#1512。
