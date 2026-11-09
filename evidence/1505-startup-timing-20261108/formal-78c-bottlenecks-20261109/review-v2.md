# 历史正式六例：限定分段表

原件 run42430097946/1，312085B，SHA256 8a33c1d6470655b845cf4c271019cceca64291536e7af5f5fa44643a3350ca8a。原6例全部超过5000ms；此表不是新源成绩。原status=failed。

## 原公式：六例各自计算，不round

|例|harness|dispatch→agentStart墙钟ms|native ACK后加项ms|原公式总ms|
|---|---|---:|---:|---:|
|1|claude_code|17324|1521.6980000000003|18845.698|
|2|codex|15448|0|15448|
|3|claude_code|15297|1213.4769999999994|16510.477|
|4|codex|14497|0|14497|
|5|claude_code|13344|1064.969|14408.969000000001|
|6|codex|17929|0|17929|

## 原公式的五个不重叠段（ms）

|例|dispatch→ensure开始|ensure自身|ensure结束→dispatch返回|返回→agentStart存储|ACK后加项|
|---|---:|---:|---:|---:|---:|
|1|1359|8109|74|7782|1521.6980000000003|
|2|1526|4678|146|9098|0|
|3|1187|7302|73|6735|1213.4769999999994|
|4|1391|3950|89|9067|0|
|5|1491|5629|184|6040|1064.969|
|6|1485|5016|167|11261|0|

## 内层观测：只能解释父区间，不追加相加

|阶段|六例实测范围ms|所属范围/限制|
|---|---:|---|
|dispatch仓库授权|729–851|属于ensure之前的dispatch工作|
|E2B create API|889–1862|包含于ensure/connect；没有独立restore/boot分解|
|read_worker|925–1352|ensure子阶段；不是Node preload时间|
|start_worker|811–1669|ensure子阶段；不是单独进程ready分解|
|worker_register|803–2889|ensure子阶段|
|fresh claim整体|1222–3080|server claim父段|
|acquire_lease|623–2146|claim子阶段；不是单SQL/RTT|
|native credentials|366–991|claim子阶段|
|GitHub credentials|208–284|claim子阶段|
|sandbox.credentials|8–15|server自身小段，不与claim凭据等同|

## 新源已有改动与仍未解决的边界

- 已合#1689的预装worker/Node additive launcher、bootstrap broker和匿名CLI准备，允许合格fresh实例复用既有初始化；后续ff2还修复diagnostic env及Codex无bootstrap carrier时collector parity的误拒。420/facb候选已留下实际采用收据。这证明采用路径发生，不能从旧read/start/register/init数值整段扣除、不能宣称正式总耗时已缩短到阈值。
- 已有workspace单读、锁内run/profile复用、credential bootstrap批次及注册批次，减少指定路径重复工作；实际fresh claim仍需owner/membership/借用双方授权/quota/health/Task/Factory/epoch/final fence。共享Smoke借用路径不受未采用own-quota候选收益覆盖。
- PR1788四个计时文件仅恢复Codex prepared.start异步continuation到原startup recorder的归属（两产品+两测试）。login/account-check等阶段成为可观察，不提前login/thread/turn，不改变native请求、时钟origin或ACK公式；默认OFF没有新增serialized phases。它不能被记成性能优化。完整PR另有其他修复，此结论只限定这四文件。
- 下一正式若仍慢，先分辨ensure/create/handoff/注册、注册后的fresh claim，再分辨仓库准备、采用后login/thread/MCP/ledger/turn与用户ACK。历史原件没有Git子段，Claude late phases为空；不能把返回→agentStart的整段归咎于某一个子模块。
- 旧Codex晚阶段已有4phase，但部分thread/MCP/ledger/turn空隙未拆开；PR1788修复只补已有recorder观测，不生成未知时间。新阶段必须取下一轮真实同origin区间，父子/并行不相加。

没有源码证据可以证明新源必然≥5s，也没有新正式六例证明<5s。旧第4例工具后证明缺失、13/14版本观测等原FAIL条件保留；本报告未重新裁决原验收。

精确每例server/native区间、当前四文件blob及已冻分析出处见observed-v2.json。未运行测试/模型/SQL/新资源。

初稿observed.json/review.md保留但不作为表格输入：它把server数值epoch误传Date.parse，前三段曾为null/NaN；v2已按原数值类型修正并逐例核五段总和。原六值与原raw从未改变。
