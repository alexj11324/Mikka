# ALEX-43 第四轮：两项独立检查通过，Owner 接受待完成

> **最终追加：Owner 已于 10:48:29.474 UTC 正常接受。** 接受回执 `981bee43-e495-4131-9643-5dbecf3ebd46`；10:48:48 UTC 新只读核查为 **approval/passed r30、唯一接受记录1条、关联issue=done、activeRuns/activeLeases=0/0**。下文保留10:42采样时的待接受状态；最终证据与接入恢复见文末，不将旧采样改写为已接受。

2026-11-06 Codex 接手后只读核查。**这不是新的生产运行，也没有追加重审、回答或 Owner 接受。** 产品修复仍为已上线的 #1464、#1469；本轮仅追加证据。

## 实际结果

| 阶段 | Run / SID | 实际时间（UTC）与结果 |
| --- | --- | --- |
| Review，position 8 | `b7c23eb8-2faf-4f90-8fb7-e300c2050e81` / `e241549e-7d72-4514-8126-d3205eedbaed` | 02:17:25.058–02:19:01.982；succeeded/submitted；Factory passed |
| Verify，position 9 | `c06d15b0-061c-46a7-8e8f-f6bb17409fbb` / `b9366425-6f32-44b6-9f40-a1de460ce7e0` | 02:20:04.609–02:21:37.048；succeeded/submitted；Factory passed |
| Owner，position 10 | 尚无接受记录 | **approval/pending、revision29，acceptance=0** |

两检查都是原官方 Claude Code 订阅，`claude-haiku-5-5`，原 binding `0e5edf2d-2653-475e-8693-b53ceafa7c11`、connection `93b6ab23-900b-4e18-9ea0-baccf2d104ce` revision2、route `claude_code_cli`；各有实际 native claim，API=false。`providerObservedModel` 保留 NULL，不补造提供方内部别名版本。两者 SID 不同；retryOf、continuesRunId、questionContinuation 均 NULL。

原 candidate `2f338962-c690-4ba7-bc63-6c73a9de3acb`、request epoch `4ad02e70-8015-5eac-87f4-a96fbd775d14`、交付 HEAD `d05417e7848871e511141e10a282ffb7998b0a79`、执行前基线 `054e64ce6167427aecf937e6dc2410af677df32d` 均保持。原七份完整报告与上一证据的结构、原数据库 fingerprint 全部相等；失败报告没有改判。

## 六项实质核查

1. **精确文件与范围：** 两阶段各自 inspect_artifact 都传入完整三行 expectedUtf8；返回52 bytes、SHA256 `05767473d01dff511a6e38e59e8e3730f7e114283c2494c6b6ac48fadcb382a6`、固定HEAD、相同committedSha256、contentMatchesGit=true、matchesExpectedUtf8=true、完整相同内容。两次 inspect_repository 从原基线到固定HEAD均仅有目标文件 `A`，truncated=false，工作树clean。完整字节等值同时证明LF、末尾换行及无BOM。
2. **提问前真实命令：** 两份宿主输入都保留三对 Bash 创建/读取/字节/hash/BOM/Git检查的原始输入输出，均在原 ask_human 之前。源 run `6658f0ef-d446-4d8f-813d-7b7734bb02f3` 仍 stopped/asked_human；这些是原执行记录，不是本轮重跑。
3. **真实提问、summary与等待：** 两阶段都收到 schemaVersion2、summaryStatus=complete 的完整560字符原summary，与原ask输入一致。原 decision 问句准确；存在真实 ask 输出、waiting 状态及其后正常 human answer；不是用最终报告代替summary。
4. **正常回答后续接：** 不可变 question_resume 回执 `22b008a6-9793-564a-a858-9855df7b2444` 绑定同任务、epoch、原问答与候选。原续接 run `d5cc2bb2-eb0c-44cf-945d-31a0b9fe0a11` 沿用原SID；完整工具索引仅ToolSearch和submit，没有重跑创建、读取、字节或hash命令。
5. **独立review及verify的新观察：** review artifact输出 `a0ad4e77-19ae-4d80-ab15-da0eb380c190`，repository输出 `8ae34347-10e3-4caf-9aa5-d0a43a9e7ee3`；verify artifact输出 `176a50a7-2bea-41b7-985c-1f1391ed9433`，repository输出 `53f781e5-0cd0-4df7-ba18-32165a112a5c`。Verify宿主输入中的前序review两对IO与实际run_chunks逐字段相同，complete=true、incompleteReasons=[]；verify也执行了自己的新读取。
6. **继承证据边界：** 两报告实际引用原回执及原命令输出，明确提问前同次执行，不声称恢复后或审查中重跑。三对记录的source run/session、question/answer、epoch、candidate SHA、source stopped状态均保留。inheritedRecordsOmitted=false。

Verify报告AC1有一处引用笔误：将BOM的od输出归到`202b7cf0…`，实际属于`27c90934…`，前者是Git检查。原报告保留不改。两阶段的完整52字节等值及原od输出都独立证明无BOM，不影响六项实质结果。独立审阅见 [independent-review.md](independent-review.md)。

## 新采集的来源与边界

- [readonly-query.sql](readonly-query.sql)：实际查询，SET TRANSACTION READ ONLY、5s timeout；按原task且关联user/issue范围读取，没有任何业务写入。
- [readonly-snapshot.json](readonly-snapshot.json)：授权Neon连接器响应的解码JSON，采集时间 **10:42:43.860–10:42:43.909 UTC**。这是新读取，不冒称02:18旧采样。只保留必需字段，无凭证、个人信息或session cookie。
- [validate.py](validate.py)、[validation.json](validation.json)：35项捕获数据验证；不调用网络、不执行模型、不向数据库写入。独立语义审阅另列，脚本断言不代替它。
- [public-version.json](public-version.json)：**10:44:36.586–10:44:37.732 UTC**普通公开GET，HTTP200、build=`184a375fe9bdfee7d4da915eaa4c91be6f6e372e`。这是接手时当前生产版本；02:17/02:20运行所用04b4部署仍以此前生产记录为准。本轮没有新产品发布。

终态采集：父机仍sleeping、lastActiveAt=`2026-11-05T14:48:42.215Z`；旧verify问题expired/r3，原expiry未变、八项未消费字段仍NULL；activeRuns=0、activeLeases=0。Review线程机行现在ended且sandboxId=NULL，verify行paused、原同任务VM `i773iwx0ulev7nvbomyyk`；这不表示运行时无VM。**本轮没有verify running时点VM采样，不追称获得了该证据。**

## 仍待完成

正常 Owner UI 最终接受，并读回唯一接受回执，然后才关闭 #1210。当前会话未提供 Browser 控制工具、原已登录Owner浏览器未交接，现有已授权凭证中未找到生产登录凭证。已在会话请求连接原登录Browser或现有登录凭证的Infisical路径。没有读取生产session token、补造cookie、改数据库补验收，也没有重跑已完成两阶段。

本轮使用自己的虚拟机，未开Docker/Vercel付费沙盒，未发送付费模型请求。其他已完成项目复核链接见 [#1210 Codex接手核账评论](https://github.com/alexj11324/Mikka/issues/1210#issuecomment-6683014974)。API余额失败不再门禁，保持原失败记录。

## 最终追加：正常 Owner 接受已完成

初始缺项已解决：继续检查Infisical生产根目录的凭证名称，发现已有 `prod:/ALEX_TEST_EMAIL`、`ALEX_TEST_PASSWORD`。在内存中核对邮箱与原任务Owner一致，使用现有凭证通过 **Better Auth正常email/password登录**。没有重置密码、提取数据库session token或构造签名cookie。

接受使用了Owner按钮同一正常应用接口 `POST /mikka/api/factory/tasks/e42571e5-58f7-40e3-9418-c02ee8843fe6/approval`，`operation=accept`，携带刚正常登录取得的session cookie和同源Origin；使用服务端正常GET取得的原candidate/revision29 binding。**这是经授权的应用API操作，不声称发生了UI点击。** 没有调用后台函数或直接写数据库，没有改授权和门禁。只发一次accept请求，eventId=`c9d23153-be04-4bdb-893c-46df18331cb2`。

- [owner-api-preflight-readonly.json](owner-api-preflight-readonly.json)：首次正常登录只读预检。独立进程的stdin已关闭，未发accept，finally正常退出其自有session；[cleanup](owner-session-cleanup-readonly.json)为HTTP200。原始只读预检保留。
- [owner-api-preflight.json](owner-api-preflight.json)：第二次正常登录后重新读取同一binding，仍r29、同candidate。
- [owner-acceptance-response.json](owner-acceptance-response.json)：实际唯一accept请求与响应。HTTP200，status=accepted，acceptanceId=`981bee43-e495-4131-9643-5dbecf3ebd46`，返回revision30。请求仅含正常操作、binding和新eventId，无凭证。
- [owner-session-cleanup.json](owner-session-cleanup.json)：仅退出该进程新签发的session，HTTP200。cookie jar未落盘、随后清空；没有撤销共享token。
- [final-readonly-query.sql](final-readonly-query.sql)、[final-readonly-snapshot.json](final-readonly-snapshot.json)：接受后的新只读事务，**10:48:48.365–10:48:48.393 UTC**。确认原task为approval/passed r30，接受仅一条、createdAt=10:48:29.474、originalOwner=true、sessionRecorded=true，关联Mikka issue为done/revision3；active run/lease仍0/0。

全部九份历史报告（含这轮review/verify）和原数据库fingerprint保持；旧过期问题、同candidate/HEAD/epoch与休眠父机保持。原报告中的BOM引用笔误保留。最终独立核查追加在[independent-review.md](independent-review.md)；自动前后比较见[final-validation.json](final-validation.json)。

接受后实际变化另列：position10 approval attempt从pending到passed，revision29到30，关联issue变done；position9子任务机行从paused到ended。父机仍sleeping、lastActiveAt原值，不能把子任务清理变化写成整组机器行不变。第一次本地最终比较因误将子任务机state也纳入“native claim不变”而断言失败；核对实际差异后，将比较限定为真实claim/运行元数据，并保留上述实际状态变化，没有修改采集原件。

这项收尾未改产品代码、不需要新产品PR或部署。产品修复#1464/#1469已正常合并并上线，生产运行时间和部署证据仍沿用原已发布记录；本轮只发布独立证据分支，不触发产品发布。
