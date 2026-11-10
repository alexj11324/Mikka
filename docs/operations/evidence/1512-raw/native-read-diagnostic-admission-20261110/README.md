# Issue #1512 — checkpoint 56：单次 Native 诊断入场与入口关闭

## 当前结论

截至 2026-11-10 04:50 UTC，正式 PR #1799 的源仍为 **5f3598029033b83ee72c88ea6c49955205eecab2**，tree **b2559ddd822059f1b69fa711d037f654a790fd2a**。正式完整登录预算仍是 **Native441 / Web331，FAIL +110**；生产案例仍为 **0/2**。

本 checkpoint 保存的是临时诊断的完整准备、测试、源码关联、单次入场和关闭证据。**没有新的正式 SQL 预算结果，也没有生产通过声明。** 前一轮原始 ZIP、五份 JSON、Node22 和全部 CI 结果见 [CP55](../formal-5f-native-budget-hosted-adapter-20261110/README.md)。

## 实际执行与资源

| 项目 | 固定值 / 实际结果 |
| --- | --- |
| 诊断候选 | `2e2f75de15a01858ac0990bbcf4b50156832dbc7` |
| 候选 tree | `23179d928269195860beaf27ad27786c7f5e7637` |
| 唯一 parent | 正式 H `5f3598029033b83ee72c88ea6c49955205eecab2` |
| Actions run | [42757687653/A1](https://github.com/alexj11324/Mikka/actions/runs/42757687653) |
| Mac job | `129635774633`，标准 `macos-26` ARM64；记录时仍在执行 |
| 源码入场检查 | 2026-11-10 04:44:03 UTC 实际 SUCCESS |
| 独立入口 | `ops/1512-native-live-diagnostic-20261110` |
| 关闭提交 | `d484f536eb1c832c1ca3ffacf05dbb20faba3f1d` |
| 关闭实际结果 | run `42757792528/A1`，job `129636119558` SKIP，runner=null、steps=[] |
| 生产/模型 | 本轮 0 个生产案例、0 个模型请求 |
| 临时 Linux VM | 两次最小 Node 验证均已 stop/delete；随后同 team GET404 |

入口采用 exact repository/ref/message/UUID/A1、单 parent H、全部文件原/新 Git SHA、SHA256、字节数及 clean checkout 的校验。只读 token，无生产凭据。运行获准后立即正常 CAS 关闭入口：workflow `if:false`、manifest `enabled:false`。原运行继续使用其不可变提交，未取消或替换。

[激活回执](run/activation.json)、[关闭回执](run/entry-closure.json)、[关闭 run 原响应](run/closed-runs-response.json)、[关闭 job 原响应](run/closed-jobs-response.json)保留实际状态。正式 PR/main 没有因这次诊断改变。

## 原测量与业务行为保持

最终 overlay manifest 包含 **16 个文件：6 新增、10 临时修改**；加入口 workflow、guard、tests、manifest，共 **20 个实际变更路径**。19 个非 manifest 文件逐个绑定，另核 21 个未改输入。原 desktop workflow 的 Native 执行段 5,068 字节逐字保留，包括安装、隔离 PostgreSQL、ARM64 build、打包、Keychain、bundled-smoke/parity/lifecycle 和审计上传。

Root 与独立审查者分别定位并核对以下原 fixture 片段，全部在候选中唯一且逐字存在：

| 片段 | 原字节数 |
| --- | ---: |
| Query window helpers | 731 |
| usable / selectFixture | 1,520 |
| 完整 Native login 测量 | 586 |
| 五组交替启动测量及计算 | 2,052 |
| 后续全部原 assertions / cleanup | 9,128 |

原 first-pair SQL 窗口、begin/end/checkpoint、五组样本、启动计时和清理未移动。原 snapshot action 白名单、实际 dispatch proof、权限/新鲜度 predicate、RPC envelope、batch 分组、404 fallback 保留；没有新增业务 SQL、轮询、业务 await 或 UI 等待连接的条件。

外层只设置 `MIKKA_1512_LIFECYCLE_READ_DIAGNOSTIC=1`。仅 lifecycle 将它变成 Electron 子进程的内部开关；smoke/parity 不启用。Main 在首次 loadURL 前安装收集器；preload 在原 top-frame/own-origin guard 内只暴露 Boolean。Web listener 与开关在首次 goto 前安装。默认关闭，没有 build flag 或新依赖。

见 [最终源码 manifest](source/overlay-manifest.json)、[Root 审查](review/root-final-admission.json)、[核心独审](review/core-final.json)、[收集器独审](review/collector-final.json)及 [候选独立回读](review/final-candidate-independent.json)。

## 诊断记录与边界

热路径只向有限内存数组写入闭集数字 tuple。字段是局部 realm/read/cache/key/action/request/channel/generation 编号、既有 readBoundary、事件枚举、HTTP status 和 Boolean；不输出真实 key、owner/workspace、URL、token、凭据或内容。同步 token 在原 await 前显式捕获，只在原 action 调用处同步恢复，绝不跨 await 伪装成全局上下文。

记录能够连接 read begin、enqueue、真实 dispatch、response proof、SWR commit、readFresh 分支、channel open/ready、onopen 与 late-subscribe 的补读原因。只在 pagehide 序列化新的 prefix；阶段快照不消费 buffer、不等待在途读取。每 realm 最多4,096 rows，最多1,024 local keys；主收集器最多128 dumps/32,768 rows，review最多64 realms。缺件、错序、计数不守恒、异常、冲突或 overflow 都保持 **incomplete**。

`complete` 只表示该阶段收到了连续的诊断 prefix，**不表示全部请求已经结束或 SQL 预算通过**。Native authenticated-profile 导出位于原 SQL 窗口之后，可能包含 prepareNativeDevice 的后续事件；不得整份并入登录计数。 原 launch('bundled') 和 waitForBundledDocument 又位于 beginQueryWindow(nativeLogin) 之前，因此最初的 renderer prefix 也可能包含窗前事件；只能按原后端窗口限定 SQL 计数，不能把整份 prefix 当作窗内活动。跨阶段去重必须使用同 realm/seq 并核每个字段，不按时间相近猜关系。F11 后接 F12 是同一决策链；F7/F13 的附加字段是 nextReadId，不能当 began。

见 [源绑定解码合同](analysis/diagnostic-decoding-contract.json)。[早连接源码路径图](analysis/early-live-source-path-map.json)与 [前端读取调查](analysis/frontend-read-path-review.json)只是可证伪的候选位置；尚未实施产品优化，也未证明提前连接能解决 +110。

## 收集器修正与实际测试

最初完整候选 `80c20073bc2338befa829f3f3b9a75256f01d755` **从未引用/发布/执行**。它的协议实际 Node29/29 通过，但后续 pinned Electron45.1.0 源审确认：unload 中旧 RFH 的 WebFrameMain 对象不保证恒等于当前 mainFrame，可能导致旧文档 dump 被误拒。此证据证明该路径存在，不声称每次同 origin 导航都 swap，也不声称正式 H 曾漏采。

V2 仅改 collector 和对应测试；其他14份源码完全不变。现在同步读取两侧有效非负安全整数 frameTreeNodeId，必须相等；子 frame、无效ID、任何 getter异常仍拒绝，且不导出 frame ID/URL。没有增加 IPC 或导航等待。见 [pinned 源分析](electron/frame-identity-review.json)及 [未发布候选记录](pre-frame-fix/superseded-before-publication.json)。

| 实际 Node24.22.1 / Linux x64 | 结果 | 范围 |
| --- | --- | --- |
| 初始协议 | 29/29 PASS | 保留原输入、结果；不冒充 V2 |
| 入场 guard | 33/33 PASS | guard/tests 未变，后续按源码复用 |
| FTN 修正后协议 | **32/32 PASS** | 原协议加旧/新对象同 FTN、两侧无效ID及 getter异常反例 |

均为0 fail/cancel/skip/todo，stderr为空。受影响的协议实际重新执行；未改 guard 未在第二个 Linux VM 复跑。两个 VM 均为1 vCPU/2GB、Node24，无浏览器、Electron、DB、账号或模型；子进程仅传 OS 环境变量。使用默认网络策略，不声称 deny-all。实际 Mac 验收另有原有本地 API/PG，不与这些离线测试混淆。

每条原始 MCP 输出先冻结，完整 gzip 与原始 JSON 逐字节核 SHA256/GitSHA，再解析全部 stdout/stderr。见 [初始验证](node-initial/verification.json)、[V2验证](node-frame-fix/verification.json)与两份 cleanup。V8 准备阶段的 event21 上界反例失败及修正独立保存在 [准备记录](review/v8-protocol-preparation.json)，它不是 Node 执行结果。

## 后续提取和生产依赖

本次 Native log/ZIP 仍由指定 reader 唯一领取，先冻结原件，再做 CRC/五份 JSON/计数核验。固定提取器只做一个必要拓扑适配：本次 checkout=head、single parent H，而非 PR synthetic 的两个 parents；下载次数、原件冻结先后、禁止向下载地址转发 token、审计和清理的其余字节均保持原样。[Root delta审查](extractor-preparation/root-guard-review.json)只批准此准备，尚不代表提取已执行；仍需真实终态、审计、artifact IDs/sizes/digests 与冻结原日志。

04:50:21 UTC 的 [只读生产依赖快照](production/latest-dependency-delta.json)：main仍f5ddb；最后Web成功；R7 42748352134失败、publish跳过、cleanup成功。UI owner已释放其段，但#1503仍在其明确声明的RO准备窗口内，不能视为全局空闲。这里只引用该owner公开投影，未读他人的原件或操作账号。

下一步以实际诊断关联确定最小产品修复，随后在未插桩的正式源验证完整 Native≤Web。再完成 source window、部署/runtime、两条官方订阅路径和 PostHog trace/AI/Logs/Replay/scouts/费用/清理验收，最后手动关闭#1512。
