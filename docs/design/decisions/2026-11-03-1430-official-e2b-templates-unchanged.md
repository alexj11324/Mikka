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

2026-11-07，主线候选的 fresh 检查拦下 Claude 的
`/usr/local/share/ca-certificates/e2b-ca.crt` 摘要变化。随后用
[一个纯官方 Claude 派生控制和一个 fresh 实例](https://github.com/alexj11324/Mikka/actions/runs/42328944425)
复现：仅添加 `/opt/mikka` 下的测量脚本和收据，不安装 Node、worker、gh 或依赖，
不执行 CLI、模型探测或订阅任务。这个普通文件在 before/ready/fresh 三阶段的类型
和 root 属主一致；ready 只发生已有的 `0644 → 0777`，fresh 才轮换 SHA-256。
原 Claude CLI 的三阶段 SHA-256 完全相同。另核实此前 desktop 的纯官方控制也有
相同精确路径的摘要变化，因此只为 Claude 和 desktop 的该路径补充 SHA 轮换许可；
Codex 已有的规则保持不变。
[完整控制、失败样本和清理收据](../research/2026-11-07-e2b-provider-root-ca-rotation.json)
绑定源提交、run、artifact 摘要和实际资源 ID。E2B 固定版本源码也有该路径的 CA
写入及 finalization 权限处理；实测 envd 二进制摘要已记录，但没有把公开源码版本
冒充该实例的运行版本。安装阶段仍不接受任何变化，类型、属主、未知权限或路径、
原 CLI 和普通证书内容继续严格校验。此控制不代表全文件发布保全、真实订阅通过
或生产时延达标；本次 Claude 控制模板和实例均已回收。

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

完整保全报告通过不可变 CI artifact 传递，跨 job 只传有界 ID、摘要和清理身份，
不把报告 JSON 放进环境变量或 workflow output/input。2026-11-07 的一次
[真实失败和恢复记录](../research/2026-11-07-e2b-report-artifact-transport.json)
显示，310,446 字节的单个环境变量使订阅及清理的 shell 在执行前就失败。
候选、接受后及发布报告仍完整保存；消费文件前校验字节摘要、source、worker、
workflow run 与 producer attempt，再执行订阅、公开模板或修改生产配置。
缺失、损坏或错绑不能放行，也不能跳过最终清理；清理只使用可信的有限身份，
保留同 source/run 较早 attempt 的精确回收能力，不据此复用旧发布证明。

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
种类、次数和耗时，不记录 URL、凭证、参数或内容。旧 worker 至少要观测到真实目录
请求开始和结束；下面的 v3 路径则须实收与 claim 元数据匹配的本地目录就绪。
非法、截断、错绑或未覆盖的远程 MCP 配置不能通过这一限定范围的证明。
子进程可能由官方 CLI 重启或直接终止，因此已观测请求配平不等于全部进程世代完整。
世代覆盖明确为未验证，全部第一方 HTTP 的完整性保持否；缺失的终态和总量是未知，
不是零。观测不得增加远程鉴权请求、数据库请求或轮询，也不为等待统计而延迟原有
取消与进程终止。官方 provider 的 OTLP 事件同样是尽力收集，不冒充完整调用总数。

MCP 计时区分响应头和正文。v1 的 `endedAt/durationMs` 仅到 fetch 返回响应头
或连接异常；v2 保持该语义，额外以 `body.endedAt/durationMs/outcome` 记录同一次
发送到 `response.text()` 完成或读取异常。它不包含 JSON-RPC 解析、stdio 交付或
官方任务 ACK，不增加远程发送。正文事件缺失保留 `null`，历史 v1 不推算正文时间；
已观测请求配平仍只指发送与响应头配对，不代表正文或全部第一方 HTTP 完整。
该扩展沿用下面的诊断 opt-in，普通任务仍不创建接收器或持久化详细收据。

启动时的 `record_decision` 静态工具定义随现有、已认证的 claim 响应一次交付。
HTTP MCP handler 和 claim 复用同一份标题、描述、Zod schema 和 annotations；
CI 使用真实安装的 MCP handler 比对完整 `tools/list` 序列化结果，保留 defaults、
required 和服务端原有的业务输入验证。目录不是权限授予：真正调用工具时仍携带
原 run token 到原业务接口，所有权、run 生命周期和幂等写入检查不变。
此改动增加有界的 claim 响应元数据，不增加数据库查询或数据库持久化内容。
daemon 只将这份最多 32 KiB 的目录传到本任务 MCP 子进程环境，不放进命令参数或
仓库。新版收到合法目录后不再请求远端目录；旧 server 没有该字段时保留原发现路径，
已提供但无效的目录不触发隐藏的替代请求。旧 daemon 继续按原协议忽略未知字段。

观测 v3 为该本地操作单列 `catalogue_ready`，只保留来源、SHA256 与就绪时间。
宿主预先从同一 claim 对象计算期望 SHA256，接收器拒绝错绑、重复或附带内容的事件。
本地就绪不计为物理 HTTP 发送；目录已准备却仍发起远端目录请求会使该证明失败。
零次目录 HTTP 必须由实收的本地就绪支持，空收据不算证明。v1/v2 历史照常读取；
v3 保留 v2 的响应头和正文边界，世代覆盖仍未验证，全部第一方 HTTP 完整性仍为否。

2026-11-07 曾让可信云 worker 无条件开启本机观测。随后确认：虽然没有增加 SQL
轮次，finish 中的 `mikkaRuntimeTiming`、`agent_start.startupTiming` 以及其中的
official CLI/MCP 收据会增加写入与读取的 JSONB 字节，不能称为数据库流量不变。
普通云任务和个人 daemon 因此统一默认关闭全部新增详细诊断；原有
`data-run-stage` 的 `stage/ms/ok`、OTel spans、日志与用户消息保持。只有明确 opt-in
的任务才创建运行计数和 CLI/MCP 接收器，并在原有消息中附加收据。

候选模板启动器保留显式宿主 opt-in。正式云端验收由 operator 配置短期
`MIKKA_CLOUD_DIAGNOSTIC_WINDOW` JSON：`version: 1`、`requesterId`、`workspaceId`、
专用 `botId`、精确 `repository`（owner/repo）和 ISO `expiresAt`，剩余时长不得超过
24 小时。在已有 claim 最终响应授权点，仅当当前主体、冻结工作区/Bot、仓库、
只读任务与 Claude/Codex 真实订阅匹配时，向现有任务环境注入
`CLOUD_STARTUP_TIMING=1`；不增加 DB 查询、不写任务授权字段、不重复 Profile
admission，也不增加 agent/tool 调用前的权限检查。未配置、过期或不匹配均不注入，
用户原有显式仓库变量机制保持。该授权覆盖专用 Bot/仓库的诊断窗口，不能说成
单 run 授权；operator 在验收后移除配置，过期配置也不能继续开启新任务。

正式 driver 明确传入专用 Bot，按正常共享配置创建、冻结并核验 Profile，不要求
普通成员写入或删除管理员工作区变量。诊断任务仍会产生明确的额外收据字节；
CLI/MCP 收据缺失、错绑、截断或额外授权往返仍判失败，不能用配置存在代替实证。
收集器随任务结束关闭，不把身份或凭据放进快照。普通任务的默认关闭以及同一
daemon 后续普通任务不继承 opt-in，由真实 supervisor 到 `outbox.push` 的输出边界回归验证；
这些回归不冒充生产 provider 回收、数据库网络字节或启动时延证明。

同日候选订阅门槛在 Codex 的 `initialize` 阶段失败，尚未执行官方 CLI 的订阅
登录，或发送 `thread/start`、`turn/start`。随后在官方 Codex 0.166.0 上做无账号控制，复现原生
OTLP exporter 拒绝压缩字符串 `none`；从真实收集器导出修复配置后，同一官方 CLI
可完成初始化。只在开启观测的 Codex 子进程最终环境中移除信号级和通用级两个
OTLP 压缩变量，使用原生不压缩默认值；Claude 与未开启观测的环境保持原行为。
没有改官方文件、扩展压缩接收器或放宽发布证明。
[失败、控制和清理记录](../research/2026-11-07-codex-startup-gate-failure.json)
保留首轮控制漏建正常配置目录而无效的结果，也区分已销毁候选与后来控制的 CLI
身份；初始化通过不代表真实订阅或生产时延通过。后续失败诊断保存有界状态、
阶段、ACK 与原 CLI 登记身份，以及已通过另一条订阅路径的严格收据，但配对失败
仍不生成接受报告或发布。测试清理同时跟踪同一 issue 的后续 attempt，Factory
取消失败时保留 issue 以便恢复，避免原 run 已结束却遗漏续跑。

同日后续候选中的 Codex 已完成真实任务和三次工具调用，但严格发布检查拒绝了
一条 `eventAt: 0` 的 provider 收据。固定版本的官方 OTLP 定义以零表示未知或缺失
时间，Rust JSON 序列化器会把它写成字符串 `"0"`。收集器因此将未知时间保留为
`null`，也不把零时间当作去重身份；有效时间与显式事件序号的去重保持原行为。
不以接收时间补写官方发生时间，不改变严格 reader、provider 证据要求或进程
终止行为。[真实失败、源码依据和清理记录](../research/2026-11-07-codex-otlp-unknown-time.json)
保留未改动的原失败收据；通过实际收集器的匿名输入只用于前瞻回归，不能改写
原发布结果，也不能替代新候选的双真实订阅门槛或完整云启动验收。

验收 fixture 的清理使用服务端解析的完整 run 链。正常链 stop 接受请求后，还须
通过既有 live 推送确认全部 attempt 的真实终态；云任务再对所有发现的 run 调用
正常 owner end API，逐项核对返回的 run ID 与 `ended` 回执，并为每条解析链做
一次既有机器视图回读，确认当前机器为 `ended` 且不再引用云资源。VM 转移后，
旧 run 的 ended/空资源行不能代替当前 owner 的回收；DB ended 写入也不能单独
证明 provider 已确认删除。Factory 取消、run 停止、end 或回读失败时保留 issue
及其 run IDs，让正常恢复入口继续可用，不将保留资源记作清理通过。
产品的 owner/lease 与生命周期处理仍由现有 API 决定；不新增产品 API、轮询或
每次 agent/tool 的授权门槛，也不要求清理前另取公开接口没有的 safePoint 字段。

该修正基于 `4f0f68e971b2676a156a3cedd7bc97413afb2310` 的实际 end/转移语义。
两条确定性假 API 回归先复现“遗漏持有 VM 的续跑”及“end 失败仍删除 issue”，
修复后 `scripts/acceptance/cloud-startup.test.mjs` 40/40 通过，另覆盖 end 回执后
当前机器仍保留资源的拒绝路径。这些离线结果只证明 driver 的控制流与证据判定，
不声称已完成真实 provider 回收或生产性能验收。

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

自定义固定模型 Profile 的重复目标核验只读取已冻结的 source/model/harness，
不再为这一步枚举无关账号、模型和 API key。实际 credential owner 仍由当前数据库
记录及工作区分享策略推导；共享订阅的 owner 成员校验、原来源行锁、后置分享与
凭证状态、epoch/catalogue、配额和持久 provider health 检查保持原边界。Profile
版本与内容锁、requester 成员提交 fence 不变，不缓存或复用前一次授权结果。
默认、继承模型和历史无 Profile 的路径继续读取完整目录，原候选排序、模型规划及
回退不变。这项缩读的离线查询清单不能代替真实 PG 锁与等价回归，也不代表已测得
生产耗时收益；正式完整入口到 ACK 的同版本样本仍是性能结论的依据。

新领取的 hosted 仓库任务可将已授权远端的 clone/fetch 与原首次 policy GET 并行。
claim 已给出的仓库身份和 GitHub 凭证仍是远端读取的依据；旧 claim 的凭证交换、
本机凭证准备及恢复路径维持原顺序。原签名校验和 Skill/session 入口检查通过前，
不创建 worktree、执行 setup、初始化空远端、启动 agent 或发送提前的阶段消息。
取消或拒绝会先 abort 并等待 Git 子进程结束，再记录本次终态；既有 TaskVM 文件
保留规则不变。没有增加或删去授权 HTTP/SQL，也没有增加持久化诊断字段。
离线回归使用真实 Git、原签名 reader 和 supervisor 到 outbox.push 的输出边界，
只证明并行、拒绝与取消语义；实际节省时间仍由固定版本的正式云样本决定。

同一次 claim 还携带已计算的 mailbox 工具名称集合，并声明现有的无状态 MCP
传输版本。新 worker 直接使用同一协议包中的输入定义，不再为目录串行发送
initialize、initialized 和 tools/list；实际 tools/call 继续经过原服务端认证及
业务检查。空目录表示禁用，存在但无效的目录拒绝，不隐式发起旧握手；缺少字段的
旧 server 仍使用原握手。旧 worker 忽略新字段。没有增加数据库查询或能力探测请求。

新领取的 hosted Claude 订阅任务，在 policy、Skill 和会话入口校验通过后，可于
同一 TaskVM 拉取代码期间使用官方 SDK 的 prewarm 准备原版进程。账号租约、模型、
普通 HOME/environment、完整 MCP 工具集和固定选项在预启动前准备好；预启动进程
停在本任务自己的临时目录，输入队列保持为空。最终工作区及 Git/Skill 校验完成后，
claim 绑定同一 session 和规范 cwd，再执行原账号来源及本地有效租约检查，最后才
发送本任务输入。初始化和接管完成都不冒充本任务的精确 ACK。

启用本次诊断时，任务自己的 PreparedAgentStart 保存预热 Promise 的闭式计时，
通过原 agent_start chunk 的 preparationTiming 字段回传。它声明
source=prepared_agent_start，并有独立的起止时间、run/harness 绑定和单调区间；
包含实际 cli_init.prewarm、接管后的 cli_init 与账号检查，准备总时间还包含等待
checkout。原 startupTiming 仍只记录晚开始的 agent_start，不把此前发生的 span
塞进该根区间，也不把两个时间轴或与 repository 的重叠相加。正式分段验证分别核对
两个边界：预热路径必须有真实成功的预热及接管初始化，普通路径仍需原 cli_init；
缺失、错误、截断或错绑不会用零或另一条路径替代。未启用诊断时不收集或新增字段。

此修复针对 1edbeca 发布的真实 Claude 候选收据：晚阶段为 114.431ms，phases 为空，
原因是已经开始的预热 Promise 没有继承后来的阶段 AsyncLocalStorage。它修复测量
归属，不改变 prompt、租约、取消、CLI 或验收起止点；不从修复本身宣称启动加速。

只有官方 SDK 在 claimed 阶段明确返回 project_settings_not_claimable，且没有
发送用户输入时，才允许先关闭并等待该进程组退出，再以同一 session 走一次普通
query；其他初始化、绑定、账号或取消错误均保留原失败。恢复、本机、旧 claim 和
不满足准备条件的任务维持原普通路径。取消及准备失败会同时终止 Git、mailbox 依赖
和预启动进程，并完成各自清理；不保留跨任务进程或额外常驻机器池。

原版 Claude Code 2.1.305 / SDK 0.3.305 的匿名四用例对照已验证待命后接管、取消、
目录缺失拒绝和项目设置拒绝，CLI 校验和不变，用户和模型消息均为零；这些是协议
可用性证据。新增路径的发布仍必须通过同一候选的两种真实订阅及正式生产计时，
不能由匿名对照或离线 SDK fixture 代替。

### 完整派发实测后的继续优化

2026-11-07 的[正式六次生产验收](https://github.com/alexj11324/Mikka/actions/runs/42392726232)
固定 source `d75bee79966ff55c881e9f96b73ce51a98fb290c`、worker、三个派生模板及
最终配套 Web，使用普通 SMOKE 账号和团队共享订阅。Claude 三次为
26.370 / 23.254 / 20.843 秒，Codex 三次为 21.664 / 20.150 / 20.823 秒，
全部超过 5 秒。[有界原件记录](../research/2026-11-07-e2b-formal-six-startup-failure.json)
保留六条结果、完整公式、发布元组与 artifact 摘要。39 个要求的服务端阶段每次齐全，
14 次实际版本核验、工具后回复、同任务原生 ACK 与资源清理通过；这些不抵消时延失败。
起点仍是完整 dispatchRun 入口，终点取服务端 agent_start 收据加非负原生 ACK 偏移，
不使用模板发布 gate 的内部 launch 时间替代，也不挑选较快样本。

该批次 dispatch 为 8.432–11.842 秒，内部 ensure 之前已过 3.565–4.922 秒；
worker claim 为 3.778–4.577 秒，仓库准备为 2.151–5.633 秒。阶段有包含及重叠，
不能相加。下一轮保留原准入位置和新鲜度，通过缩小及复用同次读取减少往返：
固定 Profile 的 dispatch、queue quota 和 claim quota 只读所选来源；继承、默认及
仅指定 harness 的原完整选择顺序不变。native binding 在双方 membership 检查后
同一查询重读原 binding 与当前 connection，保留 owner/workspace、分享及 epoch
检查且不回退到旧 binding。Factory claim 复用同一事务已锁定的 repo 行。
claim 的强制 fresh quota 仍在原位置；不在正常拒绝路径提前发 usage 或写入配额。
Factory 的两个既有 advisory lock 继续按原顺序取得，只合并为一次 PostgreSQL
原生 simple-query 往返；BEGIN 和授权前置条件保持原位置。任务快照的两条 SELECT
同样批量返回，保留 pg 原生值、排序和最终 JSON 表示。route 的来源 payload
与完整 owner/Bot/issue 谓词一次 fresh 读取，null-Bot 的 FOR SHARE 保持到提交。
所有插值使用 pg.escapeLiteral；任何批次返回形状异常都回滚，不缓存授权或锁结果。

Factory 的布尔任务授权继续每次调用完整 canonical ACL，只用既有 withoutBody 投影
避免传回任务正文。共享凭据的 share 开关与 workspace policy 在同一条 fresh SQL
中判定；缺共享、关闭共享和关闭策略仍拒绝，缺策略仍保留默认允许，不跨调用缓存。

bootstrap 的同一次文件上传仍承载私有凭据，root 命令原子发布后降为普通 user
检查并唤醒现有 wait-bootstrap 进程。只有固定唤醒收据才省掉第二条远程启动命令；
旧、缺失或退出的 preloader 保留原启动回退。信号成功不代替新设备凭证实际注册，
原 lease/stop 栅栏和注册时限保持，凭据不进入命令、参数或日志。

实例接收身份后，daemon 可在注册和 claim 期间异步只读预取已选择的官方 CLI 文件；
Codex 还按官方 launcher 的安装布局读取其 native backend。每次 daemon 激活只做
一次，256 KiB 缓冲、单文件 512 MiB、总量 768 MiB、10 秒预算；停止时先取消，
任务原有终止完成后才等待在途读取关闭。此路径不执行 CLI、不读 HOME/账号配置、
不改原文件，也不增加远端请求、数据库操作或轮询。它针对冷实例软件页读取的假设，
不是已证实的加速结果；真实 CLI 初始化、模型目录、文件保全和双订阅 gate 均保持。
下一候选仍须新的同版本完整六次生产验收，当前 #1505 未达标。

本记录保留早期 #1131、#1124 的官方文件保护要求，并取代其中禁止派生模板的
解释；独立的官方机器种类和所有者绑定凭证规则保持有效。

## E2B 构建行为依据

[E2B 模板构建说明](https://docs.e2b.dev/template/how-it-works) 和
[start/ready command 文档](https://docs.e2b.dev/template/start-ready-command) 说明：
start command 在模板构建末尾执行，ready command 成功后保存文件系统与内存状态；
新实例从这个已就绪状态恢复。因此只预加载无身份的 worker，实际 owner、设备与任务
通过启动后的正常 handoff 注入，不依赖创建实例时的环境变量去更新冻结的进程。

### 2026-11-07：统一发布后的后续验证边界

#1658 的固定 head 6d7d993a 已纳入统一发布 #1615 的集成分支；源码集成不代表
主线发布或 5 秒验收完成。后续查询优化以该批次为基底，保留其完整 run failure、
continuous tracing、critical request sampling、授权与撤销行为，不用旧版本整文件
覆盖。额外限定窗口 sampler 方案未采用，因为统一批次已提供原生 critical 采样；
后续先验证实际部署的链路覆盖，不增加第二套 claim 授权或采样入口。

全部六次完整生产失败记录仍保留。只有同一最终部署、worker/source 和三个模板
组合的 Claude 三次及 Codex 三次完整 dispatch-to-agent 均不超过 5000 ms，且原有
官方文件守恒、真实订阅和清理门槛均通过，才可关闭 #1505。匿名 CLI 初始化对照
只用于判断文件预读取假设，不能替代这项生产验收。
