# main 0e 发布与规则边界：单次只读快照
观察区间：2026-11-09 03:40–03:42 UTC。本任务不继续轮询。
范围：GitHub main/PR/公开协调评论、0a→0e规则与run-context源、0e已有运行的run/jobs/steps元数据。没有 raw log、artifact、生产API、SQL、模型、账号、VM或外部写入。

## 实际source与发布
- Git main：0e4118020311ae8f9083d0d21cfb990be0282f25；tree72f1661362ceaefde626fa7402116ae8f8ad7417；ordered parents=[0a355918330f6dac04d2b0ee4716cd056c263162,dfed4658ae974ae3703c4b07f9997f06d0aa1431]。
- PR1791 actual merged03:26:39 UTC；commit date03:26:38；author head dfed4658…。
- Exact-head push runs total_count=6，列表完整；未额外查其它source/事件。
- Web42556435874/1：job128963109103 in_progress；Build03:29:07–03:35:01 success；Upload03:35:03起进行中；public version verify pending。
- E2B42556435990/1：test/check/validate成功；validate结束03:37:28；await-web128966150496从03:37:30，具名wait step03:37:36起进行中。当前只有4 jobs，subscriptions/publish/final cleanup尚未出现；不能记成skip或PASS。
- Desktop42556435930/1：preflight128963109747正在Require the matching production Web deployment，自03:26:54。
- Image42556436012/1：image128963357199正在Install the same-revision source daemon dependencies，自03:40:57；Publish仍pending，服务清理pending。
- Publish daemon42556435852/1：FAIL，job128963109700 ended03:30:01；首红step13 Seal the exact candidate before its package acceptance test，03:29:59。npm Publish step18 skipped。没有读log，因此具体error code/根因未知。
- Main CI42556436011/1 SUCCESS，updated03:34:54；CI不是生产发布。
- 已有Git A=0e实证，但本次没有新的public A/DPL/readback/paired release R/W身份。W未从日志/artifact读取；Compare worker hash步骤success不证明具体值。新的E2B run ID不是已发布R；旧有效runtime应由已有独立receipt引用，本任务未重取它。

## 原文规则
0a→0e比较完整28路径，AGENTS/CONTRIBUTING均不在changed list。
AGENTS blob前后均9fb491b174d3be8947347fce396a7042967b3b3b；CONTRIBUTING前后均3c38da3b2a68d84187498532e8f49cf8c4bf32fa。完整原文在rules-verbatim.md，没有只用摘要代替。
本轮合成相关原义：真实冲突要解决并验证更新candidate；无关main更新不机械rebase/recheck；正常merge保留历史；最新head与synthetic CI关联；selected lane必须success。
release期间不可移动main制造mainChanged，尊重owner已发有限窗口；普通UI本地可验证不要求额外生产业务hold。E2B仍要求官方文件守恒和两真实订阅candidate gate，保留旧release回滚。
本次exact0e run-context.ts另取blob61fec2db18195fd8d77a4686b7ab8c4aeedcbe6f，与0a完全相同，真实继承无条件TRACEPARENT producer。不是用旧79aa source模拟出来的结论。

## 当前明确窗口与活动（只按owner公开记录）
- 1752/6731504553：1506 actual main发布窗口03:26:36→04:41:36，完成提前释放、不自动延长；原自然六轮尚disabled，实际READY+writers收尾后才公布原25分钟15业务+10清理。没有预占Smoke业务锁。
- 1791/6731661267（03:39:46）：P785b557f…、B7c018ac…实际prepare/bind通过；continue/Stop仍literal false、control=false/null；自然生产未激活；最近warm0/4保持。临时VM03:38:50.570已stopped。该报告不把准备source当生产PASS。
- 1752/6731607098：P0 b32与0e有coordinator store/message-safety两个真实冲突；owner在离线准备，尊重1506窗口，没有新hold。后继声明P0→Team→Enterprise→SAML，不是这些后继已入场。
- 新实际consumer：1752/6731665685（03:40:08）由1593 owner声明42557474917/1、job128966309161、driver54b3570c0a9381aacdbe24a7cc19c78a531e56ee，03:38:57过App0a/有效普通runtime门进入无repository Factory生命周期。共享Smoke互斥，business28m/cleanup4m，03:45为新模型准入硬截止；入口59ec91ec…已关闭，当前immutable run继续。它没有Main/Web/private发布hold，public build变化原driver拒绝并清理；不是全局idle。本任务没有查此run或账号，只有owner原文声明，不能替其证明清理。
- 所有相关原评论完整body/createdAt/updatedAt和body SHA在comments.json。

## TRACEPARENT修复去重最新回复
1512当前查询返回最近两条：root6731588412（03:33:49）提出精确reason；作者6731617167（03:36:12）只报告1799 head548790b…、实际synthetic90e6988…、PG与Native继续等待，没有提供此TRACEPARENT修复hunk/RED→GREEN。
因此截至本次03:40快照未观察到作者已提供同一修复；不能把沉默当同意或断言之后永不会有修复。不继续评论轮询。

## 未观察项
新DPL/公开版本/alias、实际新的W/template IDs、runtime publication、subscription业务结果及final provider清理均未读取或尚未生成。daemon seal首红根因未知。1593当前业务/cleanup终态未查询。没有以时钟、CI绿或issue仍open推定hold/释放。
