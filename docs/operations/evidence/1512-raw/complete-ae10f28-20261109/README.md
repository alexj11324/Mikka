# #1512 CP29 — ae10 完整 CI 与原始 Native 验收

此检查点封存当前候选 ae10f28aa471dbfc64f04d981b8934d374476259 在实际 checkout ddbc7e9b8e156493af730f00ed4a6efd3de475b4 上的结果。两者 tree 都为 1acbe0b8d50a7102543e24b9bd0395355bcba438，实际 checkout parents=[a2198c8c2f608f7b8169329b9da853067618dba6,ae10f28aa471dbfc64f04d981b8934d374476259]。它不是最终生产验收；ACME accepted cases=0，issue仍open。

## 当前结果

CI42603781956 attempt1 于2026-11-09 11:15:02 UTC SUCCESS，22 jobs=21success+原OIDC skip；head51checks=40success+11原条件skip。各工作流原件由唯一认领者各下载一次，本检查点复用已持久化Git blobs，不重复取得原作业日志。

| 范围 | 本轮实际结果 |
| --- | --- |
| Source | type/lint、API实际Node/Nitro启动与热替换、生成件及安全审计通过；driver完整63PASS。generate-routes.mjs本身没有--check分支，实际命令与源字节核对分开。 |
| Core | 57个正式选中target，92个Node汇总，4705PASS/0skip；显式禁用Nx cache。安装器22边界项及所有workflow opt-in校验在正式Source/Core执行。 |
| Integration | 29target；2204tests=2192PASS+12原mixed-lane skip，0fail/cancel/todo；必需真实PG另行零skip。 |
| PostgreSQL | 4shards各18suite，72suite/312文件/91Node汇总，3904PASS、0fail/skip/todo/cancel；另10个bootstrap检查不混入。Root逐项复算72行及546metric cells。 |
| Daemon/Desktop | Daemon1577PASS+2原skip；Desktop checks及Linux实际打包smoke通过。 |
| Image | 实际31条合成消息/replies、认证/邮件/独立会话/跨replica/MinIO/daemon/packaged app和升级数据保持通过；6containers+3volumes+1network有实际移除回执。 |
| Analytics SSR | 实际3匿名路径，外部采集被阻止；不是PostHog生产摄入证明。 |
| 13伴随工作流 | 全部SUCCESS，28jobs=18success+10skip；18单次原件。框架汇总3384次PASS执行，不是去重测试数；原2 Vitest skip保留。 |
| Apple Native | 原始完整登录429=19+13+397≤Web435=19+0+416；原第一对startup197≤hosted230；同源四窗全部完整。 |

PG中的“Production build and browser interactions”作业仅做DB-result门控和timing summary，不将名字冒充生产浏览器/构建执行。严格SQL实测11→6、显式auth事务2→1，但completed transactions3→4，不能说全部事务下降。

## Native 原始边界

原件24records/12checkpoints/8segments、17operations+78sources逐桶守恒，Root独算2280桶值及1291条query ordinal，0不一致。窗口包含普通邮件/auth、Native PKCE与自动导航、全部并发primary API后台流量；没有采样、扣减后台或挑选较好startup pair。主API进程的协议字节不是整机网络总字节，连接握手/TCP/TLS及独立harness SQL仍按原定义排除。

| 窗口 | Queries | Receive bytes | Send bytes | Physical / logical RPC | Unknown context / statement |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native login | 429 | 88417 | 280505 | 15 / 40 | 91 / 130 |
| Web login | 435 | 90147 | 271082 | 35 / 35 | 87 / 132 |
| FIRST bundled | 197 | 42044 | 133023 | 7 / 19 | 48 / 69 |
| FIRST hosted | 230 | 51417 | 179595 | 19 / 19 | 48 / 78 |

诊断status仍incomplete；四窗queries全部连续且已采获，overflow=false/droppedQueries=0。RPC各窗start=completion且crossesStart/crossesEnd=0。并不声称更大capture范围中的所有非窗口row均已导出。

50screen×light/dark共100原parity行通过，原threshold0.001/colorThreshold0，224changed pixels，max ratio0.00010262345679012345；原avatars/timestamps mask保持。Root复算JSON，没有直接查看这些PNG像素。3次独立Keychain进程使用同一实际签名package，lookupFailure=0；这不是App Store发布。

Lifecycle的workspaceNameCleanup为restored=false、phase=unchanged；owner/peer baseline before=false→after=true。Smoke是before/after均true且自身restored=true；Parity自身restored=true。各清理阶段和lease release按原字段分开记录，不能笼统改写为所有字段都是true。

Native实际安装daemon为0.0.551 / facb389f6cc06c453e9135bb60ada1b0f302e0d9，不是本轮app候选，也没有独立daemon worker hash。最终生产daemon、E2B及Web关联仍须发布实读。

## PostHog 有界准备

14个冻结模板不变，当前覆盖精确区分为5份历史原echo/columns、2份历史SQL hashes、6份baseline unchanged变更链摘要、1次新synthetic lookup_trace_count。只有该1次查询在本轮执行，固定2026-11-08 00:00:00–00:00:01 UTC和全零synthetic UUID，返回1聚合行trace_count=0；Root独立核request/query echo/SQL字节和返回值。未运行本轮Node normalizer，也不将0匹配宣称为实际ACME无遗漏。

projects-get仅返回可访问项目670821；会额外返回API token的project-get被自动审核拒绝，未取得token、未重试，改用无token元数据继续。0 PostHog对象写入、0模型、0Browser登录、0录制枚举。生产完整14查询分页/两个稳定快照、所有真实generation、PNG实际像素、Replay渲染、Logs/Notebook、scouts/费用仍未验收。

## 资源、失败历史与后续源

本轮唯一取证VM sbx_PX9yu7GOxcJDCgUoEtuWOlooF6fI 于11:15:35.499启动、11:19:11.709 stopped，随后delete成功并同名/project/team resume=false exact GET404。duration216210ms、activeCPU8702ms、ingress14935862B、egress383521B。费用未测，不写$0。本方当前活动资源0。其他GHA/其他owner资源只按原收尾回执限定，不能据此声称全局无资源。

所有旧RED、P0A1 Nitro失败及未知原因保留。P0A2和本轮Source实际成功不证明A1原因已确定。CP28及本检查点早期partial report保留当时pending状态；本检查点final-gates/final-review仅更新本轮终态，不修改旧测量。

11:27 fresh main 已为e78fccffd9dd878edd490b113ea80efcff1525e7，11:26:40触发的新Web/Desktop/E2B正在执行；P0#1636仍open/unmerged。ae10的绿色只绑定本检查点1ac受测tree，不能视作e78联合树验收。新main的有限交集正在独审；不取消他人发布，原owner P0先合，实际Factory窗口及提前释放/清理回执单独处理，不登记未来锁。

## 索引与使用

index.safe.json逐文件记录原UTF-8字节数、SHA-256、Git blob。原job日志保留BOM/ANSI，规范化仅用于解析。root/包含独立算术、全门禁和最终边界；三个agent目录包含各自原件、单次读取台账及原隐私/清理审阅。此处所有文件均由正常fast-forward evidence commit引用，源码分支不受影响。
