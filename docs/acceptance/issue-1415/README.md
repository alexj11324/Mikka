# #1415 验收证据

> 本页保留早期局部验证和当时未完成的清单。后续固定版本的功能发布结果见
> [最终验收报告](final-report.md)，完整历史见 [结构化证据](final-evidence.md)。
> 最终报告记录 Owner 已取消性能、一小时 idle 和 Dev ZIP 门槛；下方旧失败与
> 未执行项继续保留各自结果。现行运行方式见 [运维指南](../../operations/web-runtime.md)。

本目录保存可核对版本、环境和范围的实际结果。当前是进行中的证据记录；单元测试、数据库测试或 Linux 诊断通过，不等于 Apple Silicon 打包验收完成。

## 已完成的局部验证

| 证据 | 运行版本与范围 | 实际结果 |
| --- | --- | --- |
| [会话缓存数据库回归](desktop-session-cache-db-9fa8be5d.json) | `9fa8be5d` 加文件中列明 SHA-256 的源增量；独立 checkout、真实 PostgreSQL；包含鉴权 SQL | 23 通过、0 失败、0 跳过。`preferences.getPreferences`：web 与修正后 native 都是 2 条 SQL、635 B；原 native 为 4 条 SQL、1,694 B。 |
| [工作区旧链接与公开 Artifact](desktop-links-db-154a6efa.json) | `154a6efa` 加记录中的测试连接绑定修正；实际原始 reader、权限和数据库 | 6 通过、0 失败、0 跳过。旧 slug 两端 250 B；公开 Artifact 两端 956 B。 |
| [有界审批元数据读取](rpc-db-8e81c003.json) | `8e81c003`；真实数据库和 HTTP 边界；身份 fixture 的模拟范围已单独注明 | 16 通过、0 失败、0 跳过。完整文档 1,200,377 B，所需元数据投影 283 B。 |
| [原 Next 构建测量](baseline-build-a1b633178.json) | main `a1b633178`；Large 8 CPU / 16 GiB；`/usr/bin/time -v` | 245.21 秒，峰值 RSS 11,168,596 KiB，退出码 0。不是第二阶段最终对照版本。 |
| [真实 Electron 登录冒烟](smoke-wait-diagnostic.json) / [版本与测试增量](smoke-wait-diagnostic-provenance.json) | `9fa8be5d` 产品和后端，Linux Electron 45.1.0；仅修正测试等待器并增加安全诊断 | 7 项通过，退出码 0，精确资源清理成功。系统浏览器已有的租赁会话完成真实 loopback/PKCE；不声称完成外部 provider challenge。 |
| [Apple Silicon 打包冒烟](mac-arm-smoke-ae19.json) | 分支 `ae19ca99`，实际 CI merge/build `e4e64690`；独立 PostgreSQL 与真实打包 App | 7 项冒烟通过；随后截图的初始窗口尺寸断言失败，lifecycle 与一小时测量未运行。 |
| [原生视口回归](native-viewport-linux.json) | 记录中四个源文件的 SHA256；真实 Linux Electron，1024×768 显示器与 800×600 原生窗口 | renderer 与原始 PNG 均为 1440×900、DPR 1；边缘像素和点击通过，不缩放图片。不是 Mac 截图矩阵通过的证据。 |
| [更新后的 main 构建](main-1f647-build.json) / [原始测量](main-1f647-build-metrics.txt) | main `1f647ca1`；Large 8 CPU / 16 GiB；独立数据库 | 166.55 秒，峰值 RSS 10,894,488 KiB，退出码 0。`6149eb2b` 合入后需重新固定网页基线。 |
| [main6149 网页基线构建](main-6149-build.json) / [原始测量](main-6149-build-metrics.txt) | main `6149eb2b`；Large 8 CPU / 16 GiB；独立数据库 | 186.85 秒，峰值 RSS 11,153,512 KiB，退出码 0；生产服务与 live gateway 已就绪。 |
| [b5 候选生产构建](candidate-b5-build.json) / [原始测量](candidate-b5-build-metrics.txt) | 候选 `b5bc6b22`；Large 8 CPU / 16 GiB；独立数据库 | Next 构建 278.22 秒，峰值 RSS 11,985,344 KiB，退出码 0；随后 bundled renderer 构建和生产服务启动通过。 |
| [7973 候选生产构建](candidate-7973-build.json) / [原始测量](candidate-7973-build-metrics.txt) | 候选 `7973afa9`；Large 8 CPU / 16 GiB；保留此前 `.next/cache` | Next 构建 105.50 秒，峰值 RSS 7,093,884 KiB，退出码 0；bundled renderer 和独立服务启动通过。不是冷构建、性能提升或 Medium 完整构建证明。 |
| [实际原生凭证隔离](native-credentials-b5bc6b22.json) | `b5bc6b22`；Linux Electron；外置诊断的源哈希见 JSON | main 真实解密 bearer 与 SDK 缓存；4 份 renderer 状态快照、313 组请求头和 313 组响应头均无实际凭证；退出后 vault 文件删除、公开会话为空，精确清理通过。 |
| [b5 原版冒烟](native-smoke-b5bc6b22.json) / [运行版本](native-runtime-b5bc6b22.json) | `b5bc6b22`；Linux Electron；实际 887 个编译文件的整体 hash 已记录 | 原版 7 项通过，退出码 0，资源精确清理成功。 |
| [Mac ARM b5 局部结果](mac-arm-partial-b5bc6b22.json) | 分支 `b5bc6b22`，实际 CI merge/build `33572d6e`；run `42096996544` | 打包 smoke 7 项通过；公共页 8 屏差异 0–0.00903%。随后登录会话等待超时，完整矩阵、生命周期和一小时测量未运行。 |
| [Mac ARM 7973 局部结果](mac-arm-partial-7973afa9.json) | 分支 `7973afa9`，实际 CI merge/build `f3f72a78`；run `42108050373` | 打包 smoke 7 项和公共页 8 屏通过，随后会话未保存。新诊断证明浏览器回跳、loopback 和 exchange 200 已完成，故障位于后续接收/持久化阶段；精确清理及证据审计通过，完整验收仍未通过。 |
| [ec9 CI 局部结果](ci-ec9-partial.json) | 分支 `ec9c76a3`，实际 CI merge/build `d1584866`、base `ca256b8b`；run `42114130036` | 10 个关联 workflow 通过；Desktop 的 main 110、helper 55、platform 42 项和两端 smoke 各 7 项通过。Mac parity 在登录前的 hosted 导航阶段失败，0 屏；新的 exchange/加密/文件诊断没有执行，不能据此判断此前登录故障。精确清理通过。 |
| [1ab9 CI 与 Mac 加密定位](ci-1ab9-partial.json) | 分支 `1ab9d549`，实际 CI merge/build `14ef10d8`、base `565c7dfb`；run `42120570092` | 其余 11 个 workflow 全部通过；两端 smoke 各 7 项通过，Mac 公共页 8 屏最大差异 0.00895%。随后真实 exchange JSON/身份/token 均有效，实际 `safeStorage.encryptStringAsync()` 拒绝，尚未进入 vault 文件写入。精确清理通过；生命周期、冷启动、一小时测量和最终 Dev ZIP 未运行。打包日志明确跳过签名，正在验证修正后的完整包与跨进程钥匙串读取，不能把该线索提前写成已证实根因。 |
| [清理退出事件回归](native-cleanup-exit-regression.json) | `ec9c76a3` 加记录中的测试补丁；现有 Docker、UID 2002、Node 24.22.1 | 6 通过、0 失败、0 跳过。Linux 已能证明进程停止时，Node 的 `ChildProcess` 退出事件可能尚未送达；测试提前订阅同一进程退出，再检查退出码，保留停止边界的时间断言，产品清理实现不变。 |
| [Linux 原序列登录诊断](native-parity-auth-b5bc6b22.json) / [组合顺序诊断](native-combined-auth-b5bc6b22.json) | 固定 `b5bc6b22` 产品和记录哈希的外置测试脚本 | 单独保留共享 profile 与 8 个公共页后的真实 PKCE 通过；同 Node 组合在 hosted 首屏前失败，未重现 Mac 的登录超时，dirty 数据保留隔离。 |
| [缓存恢复与验收脚本回归](hydration-and-harness-regressions.json) | `b5bc6b22` 后的逐文件 SHA-256 增量；真实 SWR 与源码测试 | 分页审计首次读取从 0 恢复为 1；私有审计数据不落盘。共享缓存 18/18、独立时序检查 5/5、focus/navigation 25/25、idle-budget 10/10、诊断与精确清理 6/6；不是完整截图或一小时通过的证据。 |
| [真实六分钟空闲诊断](idle-b5-six-minute-diagnostic.json) / [修正后的完整短流程清理](idle-b5-cleanup-validation.json) | `b5bc6b22`；独立 UID、真实 PostgreSQL、实际前台 daemon；测试增量哈希见 JSON | 360,000.31 ms：bundled 64 SQL / 11,449 B，web 65 SQL / 12,051 B，live 正常且设备起止在线；整体因默认工作区名称被英语入口改写而失败。统一默认中文入口后，新的 10,004.44 ms 完整流程和精确清理通过。不能替代 Mac 自动安装或正式一小时测量。 |

[9f27 CI 局部记录](ci-9f27-partial.json)：实际 checkout `4eb36650` / main `82789ddf`，10 个独立 workflow 通过。Desktop 的 Linux 冒烟 7/7 通过；Mac 完整 ad-hoc 签名、严格深层验证、arm64 和 hardened runtime 已通过，随后权限声明的输出格式核验失败，尚未执行真实加解密或账户验收。主 CI 的 Factory Profile 数据库矩阵因新增用例后仍共用两分钟父级上限而超时，触发连接池清理及后续连锁失败。修正总时限及打包核验后仍须实际复验，原失败保留。

[Factory Profile 总预算复验](factory-profile-budget-4eb.json)：独立 checkout `4eb36650`，仅将包含完整迁移与顺序子用例的父测试上限从 120 秒改为 240 秒；15 秒 SQL 和 5 秒锁等待上限、全部业务断言保持不变。在既有 Large 的新独立数据库运行该单文件，113/113 通过、0 跳过，42.666 秒，进程退出 0，专属数据库清理通过。此结果不代表原 4 CPU CI 并发分片已经通过；后续正常 CI 仍是必要检查。

[82241 CI 局部记录](ci-82241-partial.json)：分支 `82241b468c`，实际 Desktop checkout `c34481fcd9`，12 个关联 workflow 中 11 个通过。主 CI 包括四个真实数据库分片已全部通过，Factory Profile 的正常并发 CI 复验完成。Desktop 的 Linux 冒烟 7/7、Mac 完整包签名和 entitlement 核验、三进程两 profile 的真实 Keychain 创建/续用/读取、Mac 冒烟 7/7、公共页 8/8 均通过；公共页最大差异 0.00895%。随后自动安装本机设备的 180 秒就绪等待失败，完整矩阵、生命周期、冷启动、一小时预算和最终 Dev ZIP 没有执行。不能据此将整个 Desktop 验收标为通过。

[54b3 CI 局部记录](ci-54b3-partial.json)：分支 `54b3cb2cc6`，实际 Desktop checkout `549518ad80`；12 个 workflow 已完成，11 个通过，只有 Desktop 失败。[完整包核验原报告](ci-54b3-mac-package.json)确认 ad-hoc 签名、严格深层签名、arm64、权限和 fuses 通过。[真实加解密原报告](ci-54b3-native-crypto.json)中，第一进程创建/读取 canary 并正常退出；第二个 hosted 进程成功解密前次 canary，也成功完成新的加密/解密，随后在关闭阶段失败。原报告只有 `NATIVE_CRYPTO_HARNESS_FAILED`，没有关闭异常的细分类别；不能将此称为加密失败，也不能把第二进程的退出或清理写成通过。第三个 verify 进程没有执行，此轮后续的 Mac 冒烟、公共/登录截图、本机设备就绪、生命周期、冷启动、一小时测量和最终 Dev ZIP 均未运行。原始 1,568 B artifact ZIP 的 SHA-256 与两个 JSON 的逐字哈希保存在局部记录中。

字节值是已预热 PostgreSQL 连接的 socket `bytesRead` 差值，范围以各 JSON 为准。上述每次读取的比较不能替代完整一小时空闲测量，也不能推广为所有路由已经验收。

会话缓存复用 Better Auth 原有签名、版本、到期和 bearer 绑定规则；没有额外 TTL。证明只保存在原生主进程的加密账户记录中，刷新由正常请求带回。数据库回归包含跨账号、伪造、到期、撤销、敏感操作重新查库、REST 续签、资料更新、一次性 PKCE 和鉴权审计失败。下一次发布后的 CI 与原生运行结果仍须绑定实际提交。

## 原生诊断状态

[真实导航关闭回归](native-close-navigation-regression.json)在既有 Linux 环境以非 root、Chromium sandbox 开启的 Electron 45.1.0 运行。[固定文件页面 fixture](fixtures/native-close-navigation.mjs)使 renderer 正在读取安装器状态时发生真实导航：原 helper 抛出上下文销毁错误，取消次数为 0，重复关闭也失败；修正后重新执行完整状态读取、取消和状态确认，取消次数为 1，原进程退出码为 0，重复关闭与精确 profile 清理通过。两轮的状态 IPC 是受控 fixture，不是实际 npm/daemon 安装；没有访问账号或数据库。[修复文件哈希与范围](native-close-fix-source-hashes.json)绑定该结果和 19/19 聚焦测试。修复只在原 20 秒总期限内重试明确的导航上下文销毁，同一应用的关闭 Promise 保留成功或失败；未知异常、未取消的安装器及真实进程退出检查仍会阻止通过。新的有限 `closeReason` 诊断不包含错误原文、URL 或路径。该回归证明了 harness 缺陷及修复，仍须下一次真实 Mac CI 确认本轮关闭故障和后续全部原生门禁。

`82241b468c` 的真实 Mac runner 已完成完整 ad-hoc 签名、`--strict --deep`、精确 entitlement 和跨进程 Keychain 验证。主程序及可执行 helper 仍须四项 Dev 权限，只有真实 `MH_DYLIB` 可无 entitlement；没有放宽加密或账号边界。该轮随后阻塞于本机 daemon 安装后的在线等待。[安装取消修复及诊断记录](native-installer-cancel-fix.json)保留了真实子进程仍在写心跳的复现；取消现在只终止安装器自己创建的进程组，并等待关闭。此缺陷尚未被证明是 Mac 超时的原因。就绪总预算改为既有 npm 安装上限 300 秒加原 180 秒其他步骤，安装终止失败则立即报告；原 online、deviceId、signedIn 和 server 条件保持不变，新增诊断只导出闭集枚举和布尔值。

[Linux 完整原生截图记录](native-parity-7973-5c0b605a.md)保留 `7973afa9` 的 100 项原始结果：58 通过、42 失败，精确清理通过。后续修复包括透传原审批接口所需的两个公开证明响应头、使用与网页相同的构建期 CSS 引擎和目标、离线布局/文案一致，以及等待实际任务活动行就绪。[源文件冻结清单](native-parity-fix-source-hashes.json)绑定这些修复；不能将源码或局部样式验证当作新的截图通过结果。组合 desktop 测试在自身 VM 为 main 114/114、helper 89/94；其余五项都在创建真实 Unix socket 时遇到环境 `listen EPERM`，未跳过或改写测试，交由正常 Linux CI 实际复验。

固定 `6149eb2b` / `7973afa9` 的[网页迁移前后视觉证据](web-parity-6149-7973.md)已齐备：原 98 项矩阵中 97 项通过，唯一浅色工作区链接因列表尚未完成而失败；原失败保留。仅补该入口的真实列表、摘要及 Computer 标签就绪条件后，浅/深色定点复验分别为 0.00540123% / 0.00478395%，均低于原 0.1% 门槛。四次采集清理通过，完整附件保留 300 张原图/差异图、两份冻结脚本和报告；不把组合证据称为一次新的完整 98/98 运行。

`9fa8be5d` 的真实 Linux Electron 已验证本地 `mikka://app`、renderer 无 Node、CSP 阻断外部 fetch，以及登录后 renderer 可访问状态不包含浏览器凭据。另一个独立的启动器诊断实际完成了 `gnome_libsecret` 加解密，且 Chromium sandbox 开启；它使用 `9fa8be5d` 启动器和此前的应用构建，不代表最终 App 已完整验收。登录交接曾因 Playwright 的 `waitForFunction` 把 Promise 当作已满足条件而过早读取空会话；改为在 Node 端等待实际 IPC 会话值后，真实冒烟通过。该短测试没有注册本机 daemon，不能当作设备在线、一小时空闲或 macOS 打包通过。

环境启动器的失败记录也已定位：编译时的版本必须与 checkout 一致，Next 请求规范化后的 `localhost` 必须与环境登记 origin 一致。所有改动保持原来的版本、数据库身份和租赁校验；原本绑定其他 origin 的数据库没有重新绑定或被接管。

## 尚待实际通过的第一阶段清单

- [ ] 所有指定页面，浅色/深色，同尺寸逐像素差异不超过 0.1%，附原图和差异图。
- [ ] Apple Silicon 打包 App 的通知、角标、更新、半透明窗口、深链接和其他原生能力。
- [ ] 真实断网启动和恢复联网。
- [ ] 成对测量的冷启动到可操作时间优于原网页壳。
- [ ] 真实一小时空闲数据库查询/字节不高于网页版；不排除实际本机 daemon 产生的后端流量。
- [ ] 凭证隔离、系统浏览器登录、IPC、CSP 和导航边界；外部 provider 回跳与应用内 PKCE 交接分别记录。
- [ ] 同一 main 基线的网页迁移前后截图一致，全部网页测试通过。
- [ ] 最终提交的全部 CI 通过，提供连隔离 HTTPS 后端的 unsigned Mikka Dev Apple Silicon ZIP。

第二阶段按 [Alex 的追加要求](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6664526271)继续推进。[兼容性研究](../../operations/issue-1415-phase2-feasibility.md)之外，共享 Vite 前端和独立 API 已在隔离工作树中实现并开始整合；这些尚未发布的实现不构成迁移验收结果。生产设置、正式签名、发布和生产切换均未执行。

[独立 Workflow 运行验证](workflow-runtime-feasibility.json) 已实际通过重试、5 秒定时、hook 和原任务的进程重启恢复。两次原失败记录保留：缺少 Local World 生命周期关闭，以及打包后 SDK 自身版本元数据丢失。显式接入官方 `start` / `close` 并保留真实包后，同一个停住的任务无需再次 `start` 即恢复完成，SIGTERM 正常退出约 1.016 秒；测试进程和端口均已关闭。这只证明 Hono/Nitro 与当前 Workflow 版本的本地集成可行，不能代替业务 workflow、Vercel 队列、网页迁移或生产验收。

[后续授权](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6667238449) 已允许自主完成必要的合并、生产切换与验收判断；[资源补充要求](https://github.com/alexj11324/Mikka/issues/1415#issuecomment-6667340920) 要求按需使用并及时停止资源。上述待验收项目继续以实际记录判断，当前阶段不会提前标为通过。
