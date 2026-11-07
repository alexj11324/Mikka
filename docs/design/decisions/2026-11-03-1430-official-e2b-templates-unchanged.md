# 官方模板只许加、不许删

2026-11-06，Alex 在 [#1505 的补充](https://github.com/alexj11324/Mikka/issues/1505#issuecomment-6691096021) 中明确：

> 「这里是有历史背景的，因为你当时删了东西，导致我们启动不了 Codex 还是 Claude Code。所以说我当时要求你不能改，但实际上我的要求是：你可以加，但是不能删。」

这条补充取代本记录原来的「不能改」、只能在新实例现场安装以及暂停派生模板发布的写法。
可以从 E2B 官方 `claude`、`codex`、`desktop` 构建 Mikka 自己的版本化模板或
snapshot；不得更新或删除官方模板，也不得删减、覆盖其中的原有文件。

## 安装边界

Node、Mikka worker 源码与构建产物、daemon 依赖、gh 和 desktop 额外依赖预装在
`/opt/mikka`。保留官方 CLI 的完整安装包、相对目录结构、Node/npm 和系统文件，
包括文件内容、权限、属主和符号链接。Mikka 的设备身份只在实例启动后写入自己的
`/home/user/.mikka`，viewer 状态写入 `/run/mikka-viewer`。任务凭证按
[1800](2026-11-06-1800-machine-is-the-execution-boundary.md) 提前交给已绑定任务的
实例，官方 CLI 使用正常 HOME 和凭证配置。任何订阅凭证、设备身份、签名密钥或
工作区数据均不得进入可复用模板。

## 发布门槛

`scripts/e2b/build-template.py` 使用 E2B 的 `Template.from_template` 在构建时执行
现有的私有目录 bootstrap，再预加载等待正常 handoff 的匿名 worker。派发时不再
下载源码、Node、gh 或安装依赖。构建前捕获官方文件清单，构建后检查原有每个
路径仍存在且校验和、类型、权限、属主和链接目标完全一致；新增路径允许存在。
清单从 `/` 遍历所有持久目录，包含 CLI 完整安装树、`/var/lib`、`/srv` 和系统安装
文件；仅排除内核挂载、运行态、临时文件、活跃日志及新增的 `/opt/mikka`。
安装完成的检查是完整的逐文件严格检查，任一原有文件变化即构建失败。

匿名 worker 在 ready 前并行向实际官方 CLI 探测模型目录，等探测进程及其子进程
退出后才允许保存 snapshot。正式 worker 按同一 CLI 选择结果和文件身份复用
预加载进程内存中的目录；首次设备注册即包含真实目录，任务领取后不再等待两个
CLI 串行重探测。没有可复用结果或文件身份变化时仍走真实探测，不硬编码模型；
自然刷新周期从实例接收 handoff 起算。探测不读取账号、凭证或任务，也不发模型请求。

首次 handoff 可附带一次性的任务 ID 提示，通过单独的私有文件绑定本次 bootstrap
完整字节的摘要；主 bootstrap 格式保持旧 worker 可读。提示只在内存中使用，不写入
设备配置，也不包含任务授权或可用凭证。worker 完成真实注册后，以原有 claim 流程
认领该任务，与首轮 heartbeat/repository 同步重叠；启动前仍等待完整仓库配置，
并执行原有设备、凭证和 fresh policy 检查。无提示、过期或无效提示走原有发现流程，
正常路径不增加 HTTP/数据库调用或定时轮询。

同一次真实匿名探测还在 ready 前原子写入只读发布收据，绑定完整 source commit、
worker digest、CLI manifest 和实际选择。CI 从新建的无身份候选实例读取并核对
这些绑定与所需模型目录，不再启动第二个完整 daemon 和第二组 CLI 重做探测。
缺失、损坏或不匹配的收据使发布失败；收据不代替下述原文件保全和双真实订阅验证，
也不进入正式 worker 的授权或缓存读取路径。

[候选验证记录](../research/2026-11-06-e2b-preloaded-receipt-validation.json) 分别保留
失败与通过的真实结果。保全失败时，在回收实例前记录受限的模板种类、阶段、退出码
和原路径/变动字段/摘要，保留原异常及清理流程；不输出文件内容、环境或任意 SDK
错误文本。诊断不改变原件检查、允许的 provider 变化或超时，也不把候选结果当作
生产端到端验收。

匿名 worker 预加载后另做 finalization 检查。2026-11-06 的
[纯官方控制实验](https://github.com/alexj11324/Mikka/actions/runs/42277103323) 证明，
即使只添加检查器、不安装或启动 Mikka，E2B 的最终启动也会更新自身机器标识、
随机种子、证书元数据及 Claude 基础镜像里的少数 Docker 状态数据库。精确路径和
前后摘要/权限见 [控制收据](../research/2026-11-06-e2b-template-finalization.json)，
允许的路径、模板种类与字段固化在 `scripts/e2b/e2b-finalization-files.json`。
这不是安装阶段的例外：安装前后仍必须全量一致；只在跨 E2B finalization 的检查
中接受已证明的字段变化，并记录完整原始摘要、受保护字段摘要和实际差异。
未知路径、未知字段、其他权限变化，以及任何原有 CLI 或软件内容变化均拒绝。

[后续 fresh-create 控制](https://github.com/alexj11324/Mikka/actions/runs/42281127309)
还证明 provider 会重新生成证书索引：Claude/desktop 各 240 个、Codex 298 个
原证书副本成为系统证书的符号链接，并重新生成 CA bundle、证书归档及 desktop
的 Java trust store。[该阶段的收据](../research/2026-11-06-e2b-fresh-create-certificates.json)
与 `scripts/e2b/e2b-certificate-relinks.json` 固定每一条原路径、原 SHA-256、精确
链接目标、权限变化和适用模板；普通证书解析链接后的内容也必须保持原摘要。
仅 Codex 已观测到的两条 E2B root 引用可指向本次 provider 注入的 root。
未列出的证书路径或目标也拒绝，不豁免整个证书目录。

构建记录轻量 CLI manifest，包含构建前官方 CLI 的真实路径和摘要；官方原本缺少
某个 harness 时，才记录 `/opt/mikka` 内补装的位置。每个 worker release 保存
自己的 `.mikka-original-cli.json`，与 worker symlink 一起切换和回退。生产 worker、
模型探测和订阅门槛共用同一个选择函数；门槛不设置额外二进制 override，官方 CLI
缺失不得静默换成 SDK 自带副本。保留实例的正常 staging 继承原记录，不改其 repo、
HOME 或 session；新 manifest 完整后才标记 worker ready。

CI 还必须在候选模板上用真实订阅分别完成 Claude Code (`claude-haiku-5-5`) 和
Codex (`gpt-6-luna`) 的一次执行，使用正常的设备注册、任务绑定与订阅授权。
只探测 CLI 版本、模型列表或启动进程不足以通过验收。两个结果和文件保全收据
都必须绑定同一候选模板、source commit 和 worker digest。没有完整收据就不能
公开候选模板或更新生产模板 ID。
任务开始证据须由官方 CLI 给出：Claude 使用同 session、同首条 prompt UUID 的
user 回显，Codex 使用本次 `turn/start` 的 ACK；`system/init` 或进程启动不能代替。
候选执行还必须有完整、未截断、绑定该 run 的宿主 HTTP 收据，证明执行期间没有
额外的 Mikka 授权或 provider proxy 往返。真实回复和任务/模型/订阅绑定仍分别核对。

HTTP 证据按实际覆盖范围解释。`HttpServerLink` 与宿主 `taskFetch` 的物理发送计数
覆盖宿主的授权、代理及任务传输入口；它不能独自证明官方 CLI 子进程发出的全部
Mikka 请求。`mikka-mcp` 的唯一远程发送路径只允许工具目录发现与显式
`record_decision` 业务写入，两者不是 `/v1/runs/:id/decision` 的权限判定请求。
固定 worker 版本的闭式路径审计和真实进程回归，与宿主实际计数一起支持
“执行时没有额外鉴权或代理往返”的判断，不能把业务 API 内部的权限校验说成不存在。

冒烟及候选订阅门槛使用既有的本机观测接收器，另记这些子进程实际发送的固定业务
种类、次数和耗时，不记录 URL、凭证、参数或内容。至少要观测到真实的目录请求
开始和结束；非法、截断、错绑或未覆盖的远程 MCP 配置不能通过这一限定范围的证明。
子进程可能由官方 CLI 重启或直接终止，因此已观测请求配平不等于全部进程世代完整。
世代覆盖明确为未验证，全部第一方 HTTP 的完整性保持否；缺失的终态和总量是未知，
不是零。观测不得增加远程鉴权请求、数据库请求或轮询，也不为等待统计而延迟原有
取消与进程终止。官方 provider 的 OTLP 事件同样是尽力收集，不冒充完整调用总数。

worker 升级重新构建带唯一版本名的三个模板，不覆盖旧模板或别名；上一版有效配置
保存在 `MIKKA_CLOUD_RUNTIME_PREVIOUS`，旧模板继续保留以便回滚。三模板 ID、
worker SHA、source commit 与模型目录必须整组匹配；单次 upsert 后逐项回读，
部分写入或错配必须重新验证，且不能覆盖有效的 previous。模板发布和应用配置
更新沿用 GitHub Actions 与 Web deploy 的发布队列，保持来源版本校验。
构建部分失败、source 过期、等待应用失败或订阅失败时，最终清理步骤按本次
source/run/attempt 标记关闭全部探测实例，再按唯一名称和 ID 删除仍为私有的候选。
名称必须通过 E2B 的 `/templates/aliases/{alias}` 解析，再按真实模板 ID 核对归属与
明确的私有状态；不能把名称传给 ID 路由，用得到的 404 证明镜像不存在。记录已有
ID 时，即使别名消失仍检查该 ID；别名重指向另一 ID 时拒绝删除。删除后按真实 ID
回读确认不存在，清理失败使工作流失败并保留收据。已公开模板及 previous
不删除；失败后的重试需要重跑整条流水线以重新构建候选。

## 性能与成本

[#1505](https://github.com/alexj11324/Mikka/issues/1505) 的生产验收仍是派发到 agent
开始执行至少三次均不超过 5 秒，目标 2–3 秒；建机本身的时间不能代替端到端时间。
正式起点必须是 `dispatchRun` 第一行，日志标记 `boundary: 'dispatch_run_entry'`，
包含最初的 Profile/模型等前置校验；终点取服务端执行 stage 和本任务官方 CLI
exact ACK 两者较晚的时间。没有入口标记或确切 ACK 的样本不能通过。
固定生产版本的[六次基线](../research/2026-11-06-cloud-startup-production-baseline.md)
从 legacy dispatch body 起算，到执行 stage 为 Claude 82.528–94.567 秒、Codex
80.400–90.430 秒，只是完整入口延迟的下界；可用于分析真实分段，不得冒充完整
起点或用于证明 ≤5 秒。[三模板组件对照](../research/2026-11-06-e2b-natural-cache-comparison.json)
另记派生 create 与实际 pool claim/resume，保留每组缓存、资源、worker 和 source
边界；它不包含任务派发、领取和官方 ACK，也不能代替生产端到端成绩。
先测原流程分段基线，再测派生模板。只有仍不能达标时才按实测选择预热池或组合。
运行费用由任务所有者自己的 E2B key 承担，空闲机器自动暂停或回收，不新增数据库轮询。

本记录保留早期 #1131、#1124 的官方文件保护要求，并取代其中禁止派生模板的
解释；独立的官方机器种类和所有者绑定凭证规则保持有效。

## E2B 构建行为依据

[E2B 模板构建说明](https://docs.e2b.dev/template/how-it-works) 和
[start/ready command 文档](https://docs.e2b.dev/template/start-ready-command) 说明：
start command 在模板构建末尾执行，ready command 成功后保存文件系统与内存状态；
新实例从这个已就绪状态恢复。因此只预加载无身份的 worker，实际 owner、设备与任务
通过启动后的正常 handoff 注入，不依赖创建实例时的环境变量去更新冻结的进程。
