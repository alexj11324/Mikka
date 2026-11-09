# PR #1799 · Native 6414 实际预算 RED

本目录保留 CI `42663994959 / attempt 1` 的 Apple Silicon job `129327506300` 原件。功能 CI 和 lifecycle 的原 result 为 passed/success；issue #1512 的两项 SQL 预算均为 **FAILED**：

- 完整登录：Native **433 > Web 431**，超出 2。
- 原始 FIRST startup：Native **209 > hosted 147**，超出 62。

结果没有重跑，没有挑选后续 pair，没有扩展窗口或扣除任何 unknown/后台 SQL。父任务及独立 source/ledger reviewers 获得同一 immutable lifecycle 原件继续诊断；本目录不宣称已定位原因或已修复。

## 固定来源与一次读取

PR head：`6414a08ddb4a92962bc82e9e427c391d645cacb2`。Native 自身原日志与有 revision 字段的原 JSON 确认实际 checkout `576c903cd6ede14520a79111d2b71154968ad910`，tree `05b40c13c233d7f3cef989011705cf624b27c507`。Git commit 有序 parents 为 5ba1f9e2359ce714d83cd16fc040f2567c40a6d0 与上述 head；该 Git API 由 current_source_review 唯一读取并封存于 2b1563d80127a47bf83d6c5f9d7831b76a465e29，本 reader 没有重复该 API。

Native job 于 17:31:06Z 开始、17:50:31Z 自然结束，26 steps 完成，无失败步骤。原 decoded job log 256735 B，SHA256 `b04b98c60ff10c275207c1f50795f13528bbcff7ee4281afe5576a26e50c6873`。

| 原 artifact | ID | ZIP bytes | SHA256 |
| --- | --- | ---: | --- |
| Native | 13698061905 | 14614498 | c15ba5b16d839373e12f24ad54071bb276265dbf1fcd7eafa6b92ccc5b992e9f |
| Package | 13697842275 | 1598 | 9f3bdb8d7350b332e3fc19f021bb63d45aa314964a6c53e71f47cf78b8f5456f |

两 ZIP 均只调用 GitHub download tool 一次，再各通过其已返回文件引用恢复一次；没有 refresh 或旧原件重下载。bytes/SHA256 与 API 完全匹配，ZIP CRC 通过，路径安全检查通过。完整索引覆盖 310 个文件、18248521 B 解压后条目字节。

五份关键 JSON 逐字保留。原 lifecycle 为 686827 B，SHA256 `756aa75ae6b482b1e1a7ab1006c8451ac0650af09391ffa480d937efc8b4b06f`，Git blob `633c0569408df7076b91df290bd9b4456d7992ef`。原始 ZIP 继续由上述 GitHub Actions artifact IDs 保存；公开 Git payload 含五原 JSON、完整文件哈希及日志，不含原 ZIP 或临时下载 URL。

## 原完整窗口

| 窗口 | queryCalls | 原分段 | PostgreSQL 接收字节 | PostgreSQL 发送字节 |
| --- | ---: | --- | ---: | ---: |
| Web 完整登录 | 431 | 19 + 0 + 412 | 89466 | 269826 |
| Native 完整登录 | 433 | 19 + 15 + 399 | 90177 | 285126 |
| Native FIRST，pair=1 | 209 | 209 | 45133 | 171880 |
| Hosted FIRST，pair=1 | 147 | 147 | 31780 | 72688 |

正常邮件认证、Native PKCE、自动 renderer 导航、真实工作区选择和全部主 API 后台流量均包含。没有采样或推测扣除。既有排除仅为独立 harness 的租约/fixture SQL、连接握手与 TCP/TLS 开销。protocol bytes 不等于所有网络流量，在途返回字节可能跨 checkpoint。

FIRST 仍是原五对生命周期序列的第一对。正常会话/profile/OS 缓存保持，后端已 warm。Hosted FIRST 的 4 个跨终点 RPC 仍原样留在该边界；没有把它们之后的 SQL/字节移回原窗口。

## 守恒和未知归因

从同一组原件纯 V8 重算：**24 records、12 checkpoints、8 segments、2280 桶值、1220 连续窗口 ordinal**。记录总和、前后差分、全部 17 operation 与 78 unattributed-source 桶及 ordinal 投影均一致，守恒/来源错误 **0**。校验函数保留的错误只有两项预算超标，不将总体结果改写为通过。

| 窗口 | Physical started/completed | Logical started/completed | Logical crossesEnd | Unknown context | Unknown statement |
| --- | --- | --- | ---: | ---: | ---: |
| Web 登录 | 35/35 | 35/35 | 0 | 87 | 128 |
| Native 登录 | 16/16 | 40/40 | 0 | 91 | 132 |
| Native FIRST | 6/6 | 19/19 | 0 | 53 | 75 |
| Hosted FIRST | 15/11 | 15/11 | 4 | 37 | 45 |

细粒度 diagnostics 原状态均为 **incomplete**，原因是 context/statement unknown；未归零或声称完全归因。四窗 uncaptured=0，全 collector droppedQueries=0、overflow=false。Hosted FIRST 的 physical 与 logical crossesEnd 均为 4；completedInWindow=11，completionNotObserved=0，其余三窗 crossesEnd=0。完整 action/segment/statusCounts 与 collector 原原因计数在 rpc-diagnostics.safe.json 中，原内部 invocation/ordinal 留在完整 lifecycle 中。

动作次数或 statement 结构相同不能证明参数相同或业务工作重复。本目录没有据此删除功能或改变授权。

## 实际 daemon 与功能检查

本轮 bundled/hosted 都实际连接 daemon **0.0.564**，installedRevision `8db16095f46be955df22f42914e0f89b6e5f3d11`，protocolVersion=3。这是独立已发布 daemon 的实际身份；不能用 App SHA 代替，也不能据 Native 观察推导 E2B runtime 身份。本目录不把相较前轮的变化仅归因于 App 六文件差异。

parity 报告覆盖 100 屏（50 required × light/dark），阈值仍 changed ratio=0.001、color threshold=0，既有 avatars/timestamps masks 与 geometry 原样保留。changed pixels=332/129600000，max ratio=0.00010262345679012345，page errors=0。本 reader 核对报告/算术，没有声称逐张观看 PNG。

三独立 packaged process Keychain 验证通过，sameImmutablePackage=true、lookupFailureCount=0、进程退出、日志未截断。包是 arm64、ad-hoc Mikka Dev acceptance variant，strict/deep signature 审计通过；完整 fuse/entitlement 原值保留。这不构成生产 App Store 发布证明。

五对时延原值保留：Native median=3167.33 ms，hosted median=3183.79 ms，improvementPercent=0.52。原合同没有时延门槛，不能用该数值抵消 SQL RED。

## 清理与 baseline 分列

- lifecycle cleanupStages 原样保存，nativeCleanup.cleaned=true，account observation state=released。
- **lifecycle workspaceNameCleanup.phase="unchanged"、restored=false**；没有写成所有清理布尔均 true。
- lifecycle owner/peer sealed baseline before=false/false，after=true/true。原差异为 workspace_audit_outbox 清理。
- smoke owner/peer sealed baseline before=true/true，after=true/true；workspace restored=true。
- parity workspace restored=true；其 native cleanup 和全部原字段另保留。

## 全部 workflow/check 元数据

末次 exact-head 快照为 2026-11-09 17:53:14 UTC。9 个 workflow 全部 completed success/A1；它们共有 38 jobs：31 success、7 skipped。39 个 head check runs 为 32 success、7 skipped，其中额外一项为 GitGuardian；legacy statuses 返回空列表。

所有 run、job、check 分页总数均与完整返回数组相等，ID 无重复，head 匹配，38 jobs 各自映射到 check，缺项/状态不一致为 0。伴随终态 job 页在各自完成后读取并复用，末次 run_attempt 均仍为 1。六个 E2B 发布相关 jobs 和主 CI 的 OIDC job 实际 skipped；没有把它们写成生产发布通过。最终 strict job129338527147 于17:50:34Z–17:50:42Z success，原日志由 root 唯一负责。

**功能 CI green 和本轮 #1512 SQL budget RED 同时成立。** 此 metadata 不是生产验收或 branch-protection 规则审计。

## 取证资源与公开边界

唯一取证 VM 为 1 vCPU / 2 GiB、900000 ms 硬上限、nonpersistent、无公开 ports、限定 artifact 域名；未执行任何 Native 测试、业务或模型。94 个 gzip chunks 恢复后，gzip、JSON 与各原文件 bytes/SHA/Git blob 均校验，五原 JSON 与完整哈希索引持久化后立即 stop、delete，同 project/name 的 resume=false 精确 GET 返回404 not_found。

实际 duration=160925 ms、active CPU=8057 ms、ingress=14881848 B、egress=319338 B；延期0，剩余自有资源0。未读账单，金额仍 unknown，不声称费用为零。

公开 payload 凭据/邮箱形状扫描无命中；原件未改写或脱敏重制。SAS、文件引用 URL、平台私有响应和命令环境变量不进入公开包。没有读其他负责人的原日志、没有改 Git ref、没有触发生产请求、模型、CI 重跑或新的控制实验。
