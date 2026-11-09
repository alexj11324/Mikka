# PR #1799 · Native 6cc 联合源验收原件

本目录绑定 CI `42653081708 / attempt 1` 的 Apple Silicon job `129290330575`。任务于 2026-11-09 16:27:50Z 开始、16:46:01Z 自然结束，结论为 success。唯一原件读取者为 `/root/native_6180_review`；没有重跑、取消、挑选后续启动对或改动预算。

## 来源与完整性

- PR head：`6cc38aca620d16b25eebe0c8787747885a2cceb1`。
- 原 job 日志与具备 revision 字段的原 JSON 所确认的实际 checkout：`16dcb17d4d20c32ffbc3f4d3e40b05a594d340f6`。
- Git API tree：`9628e365dede1eaf6b45bab3ad35dfce11fbdace`；parents 为 e189d7652fd2fce48b77a3697abf5bb177d8ebd1 与上述 head。实际树与候选树一致。
- Native artifact：`13691963476`，14,609,848 B，SHA256 `80ac3291bd4fb7d3fb114ee3ed6135a909841befc92c09677bb32f39c204686b`。
- Package artifact：`13691838702`，1,595 B，SHA256 `3600d610be8fd6588e5b081a199d9ce35cb387139f4b5fe95a63d3ab5447c21e`。
- 两个 ZIP 均逐字下载一次、匹配 API size/digest、通过 CRC 检验。完整索引包含 310 个文件、18264843 B 解压后条目字节；五份原始 JSON 未改写。
- 原 decoded job log 为 254,493 B，SHA256 `68f6cda7bb85e00147d2162ddc5a2e4a71519c4552ec76cc57edc83b51085ed6`，保留原 UTF-8/BOM/ANSI 字节。
- 原始 ZIP 留在上述 GitHub Actions artifacts；本目录保存原 JSON、完整文件哈希和下载/恢复证明，不把 ZIP 或临时下载 URL 加入 Git。

## 原完整窗口与 FIRST 对

| 原窗口 | queryCalls | 分段 | PostgreSQL 接收字节 | PostgreSQL 发送字节 |
| --- | ---: | --- | ---: | ---: |
| Web 完整登录 | 435 | 19 + 0 + 416 | 90,154 | 271,089 |
| Native 完整登录 | 425 | 19 + 15 + 391 | 87,768 | 279,216 |
| Native 第一对启动 | 213 | pair = 1 | 46,100 | 173,661 |
| Hosted 第一对启动 | 220 | pair = 1 | 48,433 | 141,988 |

两项原 SQL 门槛通过：425 ≤ 435，213 ≤ 220。窗口保留正常邮件认证、Native PKCE、自动 renderer 导航、工作区选择，以及同一主 API 进程的全部并发后台流量；没有估算扣除，也没有按请求耗时挪动 SQL。原 FIRST pair 来自未变的五对生命周期序列；没有用其它 pair 替换。会话/profile/OS 正常缓存保留，服务器已经 warm。

计量包括主 API 进程全部真实 pg.Client.query 调用与 PostgreSQL protocol bytes，不采样。既有排除仅为独立 harness 的租约/fixture SQL、连接握手与 TCP/TLS 开销。protocol bytes 不是所有网络字节；在途返回字节可跨 checkpoint。

## 守恒、RPC 和未知项

纯 V8 从同一批原 JSON 复算：24 条记录、12 个 checkpoint、8 段、2,280 个 operation/source 桶值和 1,293 条窗口内连续 ordinal，错误 0。每条记录的 17 个 operation 桶之和等于 queryCalls，78 个 source 桶之和等于 nested unattributed；窗口、段、前后差分和 ordinal 投影均一致。

| 窗口 | Physical RPC | Logical actions | Unknown context queries | Unknown statement queries |
| --- | ---: | ---: | ---: | ---: |
| Web 登录 | 35 | 35 | 87 | 132 |
| Native 登录 | 14 | 40 | 91 | 129 |
| Native FIRST | 8 | 19 | 53 | 76 |
| Hosted FIRST | 19 | 19 | 48 | 72 |

所有四窗的 crossesStart、crossesEnd、completionNotObserved 和 completionWithoutStart 均为 0。uncaptured=0；collector droppedQueries=0、overflow=false。细粒度 query diagnostics 的原状态仍为 **incomplete**，原因是 context/statement unknown；这没有被改成完整归因或归零。完整 collector 的 context_missing/context_invalid/statement_syntax 原原因计数另保留于回执。

Native 完整登录多出的逻辑 action 是 task-runs.pollTaskRuns 4 vs Web 0、desktop.session 1 vs Web 0；其它逐项次数一致。第一对两侧 19 个逻辑 action 的逐项次数一致。次数或形状相同不证明参数相同，也不证明业务工作重复。原 invocation/ordinal 明细保存在未改写 lifecycle JSON；安全摘要不重新打印内部关联 ID。

## 生命周期、界面与 package

100 张界面对照报告覆盖 50 个 required screens × light/dark。阈值保持 changed ratio 0.001、color threshold 0；仅既有头像/时间遮罩，mask geometry 匹配，page errors 0。报告总计 201 / 129,600,000 changed pixels，最大 ratio 0.00003935185185185185。本代理核对报告和算术，没有声称逐张人工观看 PNG。

三次独立 packaged process 的 Keychain 检查均通过，进程退出、sameImmutablePackage=true、lookupFailureCount=0、日志未截断。包为 arm64、ad-hoc Mikka Dev acceptance variant，strict/deep 签名审计通过；这是 inspector-enabled harness 包，不是生产 App Store 发布证明。完整 fuse/entitlement 原值保留在 package JSON。

五对冷启记录仍完整保留：Native median 2618.43 ms、hosted median 2218.84 ms，Native 本轮更慢，improvementPercent=-18.01。原合同没有时延通过阈值；该描述性结果没有被隐藏或替换。

## 清理字段必须分开阅读

- lifecycle 的六个 cleanupStages 为 passed，nativeCleanup.cleaned=true，租约 released。
- **lifecycle workspaceNameCleanup.phase="unchanged"，restored=false**。这与 afterName/ownerMatchesSealedBaseline 的匹配状态分列，不能改写为“所有清理布尔均 true”。
- lifecycle 的 owner/peer sealed baseline **before=false、after=true**；原差异为 workspace_audit_outbox 的一行在清理后移除。
- smoke 的 owner/peer sealed baseline **before=true、after=true**。smoke 的 workspaceNameCleanup.restored=true。
- parity 的 workspaceNameCleanup.phase="restored"、restored=true，native cleanup 和其余原字段照录。
- Native 两种 renderer 实际 hello/installed daemon 均为 0.0.562，installedRevision `111a8dfb8b227ac0441324339ff42e4328ea609a`。这是另行发布的 daemon 身份，不能推导为本次 App checkout，也不能当成 E2B runtime 身份。

## 取证资源与公开边界

仅创建一台 1 vCPU / 2 GiB、15 分钟硬上限、nonpersistent、无公开 ports、限定 artifact 域名的取证 VM。五份原件和完整哈希索引发布到不可变 Git blobs 后立即停止、删除，并对同 project/name 以 resume=false 精确 GET 得到 404 not_found。

实际 duration=238,136 ms，active CPU=10,003 ms，ingress=14,867,942 B，egress=313,470 B；延期 0、剩余自有资源 0。没有读取账单，不声称费用为零。

公开 payload 的凭据/邮箱形状扫描未命中。SAS、下载 URL、私有平台原响应和 VM 环境变量不在公开包中。第一次 RAM 拼接对 Uint8Array 使用 Array.concat 导致本地长度校验失败，随后仅把同一批已保存 chunks 转 Array.from 重组；没有重下载原件。最终 gzip、解压 JSON、各原文件 bytes/SHA/Git blob 都验证相等。

这是一轮固定源的 Native/hosted 非生产验收。生产账号、真实模型、PostHog backend、Replay 实际播放、E2B runtime 和 issue #1512 最终生产验收仍由父任务单独执行，不能由本目录的通过值替代。
