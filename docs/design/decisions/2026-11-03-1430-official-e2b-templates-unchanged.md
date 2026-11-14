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
`/home/user/.mikka`，viewer 状态写入 `/run/mikka-viewer`。所选原生 CLI 认证与获准的 GitHub 凭据按
[1800](2026-11-06-1800-machine-is-the-execution-boundary.md) 交给已绑定任务的实例，
官方 CLI 使用正常 HOME 和凭证配置。其他第三方 API Secret 的交付单独遵循
[0240 凭据暴露边界](2026-11-08-0240-credential-exposure-boundary.md)，不能解释成
向 Agent 批量注入所有 Secret。任何订阅凭证、设备身份、签名密钥或工作区数据均
不得进入可复用模板。

模板依赖安装使用同一 release 内新增的私有构建工作区，只选择 daemon、protocol、
config 三个 worker 工作区；保留这些包的完整源码及生产、开发依赖。原始源码归档
不改写，原 workspace 安装策略、overrides、patches 和锁定版本继续生效。派生根项目
不带 Web 依赖，安装锁只投影所需 importer；包与 snapshot 记录不重新解析版本。
正常 `--frozen-lockfile` 安装及获准的生命周期脚本仍须成功，再通过相对
`node_modules` 链接供原 worker 构建入口和 CLI manifest 读取。工作区与链接均在
该 release 内，整体 staging 发布移动后仍须可解析，并可供正常 worker 用户读取。

这一区分来自 2026-11-09 的两次实际构建失败：
[第一次](https://github.com/alexj11324/Mikka/actions/runs/42566225093/attempts/1)
在根项目专用的 `ffmpeg-static` 二进制下载收到 HTTP 504，
[第二次](https://github.com/alexj11324/Mikka/actions/runs/42566225093/attempts/2)
则在 desktop 的同包 LICENSE 下载失败。该包原安装器仅凭二进制已存在就可提前
返回成功，因此原地重试不能证明下载文件齐全。修复针对 worker 的安装集合，
不通过禁用脚本、忽略缺文件或降低校验门槛放行。原失败与清理回执继续保留；
隔离构建通过也不替代新模板的完整文件守恒、双真实订阅及生产五秒验收。

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
该次控制仅在 Codex 观测到两条 E2B root 引用指向本次 provider 注入的 root。
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

2026-11-09 的[纯官方定点控制](https://github.com/alexj11324/Mikka/actions/runs/42628079564)
又证明 Desktop 在 fresh 阶段将两个原普通文件重新链接：
`/etc/ssl/certs/1560546e.0` 在 fresh 阶段的精确 symlink target 为 `e2b-ca.pem`，
`/etc/ssl/certs/e2b-ca.pem` 在 fresh 阶段的精确 symlink target 为 `/usr/local/share/ca-certificates/e2b-ca.crt`。
两条规则仅适用于 `desktop`，原文件 SHA-256 均须为
`4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1`，
解析终点必须是该精确根路径的普通文件，内容与同阶段 provider root 一致。
本轮 mode 和 uid/gid 均未变化，不增加 mode 例外，不改变 Codex 规则；
strict 安装阶段仍拒绝原文件转链接，仅显式 finalization 接受这两条受控变换。
[原控制收据](../../operations/evidence/1506-official-desktop-certificate-relinks-20261109.json)
及[范围说明](../../operations/evidence/1506-official-desktop-certificate-relinks-20261109.md)
保留 Codex 的阴性结果；该定点控制不代表全量文件保全、真实订阅或发布通过。

2026-11-09，实际主线 `8db16095f46be955df22f42914e0f89b6e5f3d11` 的
[R7 42656120803/1](https://github.com/alexj11324/Mikka/actions/runs/42656120803)
在 Claude fresh 检查被同两条 CA 引用的 file→link 转换拦下。原发布 owner 的
[失败和精确清理回执](https://github.com/alexj11324/Mikka/pull/1810#issuecomment-6745930838)
记录两份原文件的 SHA-256 均为 `4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1`，
fresh 的精确链接依次为 `e2b-ca.pem` 和 `/usr/local/share/ca-certificates/e2b-ca.crt`。
三项本 run 候选均已删除，最终清理确认精确名字 absent、sandbox 和 errors 列表为空；
真实双订阅和公开发布均未执行。这个失败不等于新运行时或五秒验收通过。

后续独立官方 Claude 对照
[42661569263/1](https://github.com/alexj11324/Mikka/actions/runs/42661569263)
在没有安装 Mikka 产品、worker 或执行 CLI/模型的情况下复现了同一变化。
固定观察源码为 `7fd8a2681cd71bb6603a485854c8beda2044911b`；
`623a1afd8715433a58c3e88ce88f8fbcc29d1761` 仅是该控制所用 cleanup helper 的产品上下文，
不是失败 R7 的源码，也不是官方 base 身份。观察程序只新增 `/opt/mikka` 下的诊断文件。
四阶段 `before / pre_finalization / ready / fresh` 中，前三阶段两条 CA 引用都是
上述 `4e04ce…` 普通文件，仅 fresh 变为上述精确链接；三节点全程 mode `0777`、
uid/gid `0/0`。根证书保持普通文件，本轮 fresh 摘要是
`0459a4cfe2cc288afae322259a84a08910e65282d89dc06e94f5e1b80d3c6cb4`，
两条实际解析链的终点路径和摘要都与它一致。
[控制来源、完整结构化观测、原件摘要和清理回执](../../operations/evidence/1782-official-claude-certificate-relinks-20261109.json)
保留四阶段观测及本轮一个私有模板、一个 fresh sandbox 的精确清理回执。
原 schema 没有采集官方 base 的 immutable ID、base build ID 或 envd version，
这些字段保持 unknown，不能用诊断衍生 build ID 替代。

因此仅为 `claude` 追加两条精确规则并同步摘要和控制来源，原 320 条规则保持。
匹配算法不变：原摘要、原 file 类型、精确链接、mode/uid/gid 不变及精确
provider root 普通文件终点均继续校验；provider 每次启动的实际 root 摘要
可轮换，不要求它等于旧 `4e04ce…`。不增加 mode 例外；strict 安装阶段、
官方 CLI、普通证书、其他路径和模板的拒绝条件保持。
测试保留原用例和原失败证据，仅将已被新行为取代的 Claude 正确形状旧负例
更新为 Claude 错误旧摘要负例，并增加针对该规则的正例和拒绝回归。
本 PR 的本地回归为 34/34、0 skip；完整红绿原件固定于
[800eff40 的候选证据](https://github.com/alexj11324/Mikka/tree/800eff40eeead9c78fb83cd2260adc0cf40fbd4f/claude-ca-relink-candidate-20261109)。
导入的控制发布者范围说明保留其独立的 33 项回归结果，不混作本 PR 的测试计数。
这个三路径定点控制不代表全量文件保全或发布通过；完整保全、真实双订阅及
同一生产元组六次 ≤5000ms 仍须由后续实际发布和正常 Task 验收完成。

构建记录轻量 CLI manifest，包含构建前官方 CLI 的真实路径和摘要；官方原本缺少
某个 harness 时，才记录 `/opt/mikka` 内补装的位置。每个 worker release 保存
自己的 `.mikka-original-cli.json`，与 worker symlink 一起切换和回退。生产 worker、
模型探测和订阅门槛共用同一个选择函数；门槛不设置额外二进制 override，官方 CLI
缺失不得静默换成 SDK 自带副本。保留实例的正常 staging 继承原记录，不改其 repo、
HOME 或 session；新 manifest 完整后才标记 worker ready。

CI 还必须在候选模板上用真实订阅分别完成 Claude Code (`claude-haiku-5-5`) 和
Codex (`gpt-6-luna`) 的一次执行，使用正常的设备注册、任务绑定与订阅授权。
每条路径至少完成一次独立于 handoff 的成功工具执行，并在工具完成后给出正确回复；
`submit` 等 handoff 只证明交付，submit-only 不算执行证明。
Codex 原生 `bash` 必须 `exitCode === 0`，`apply_patch` 必须 `status === 'completed'` 才计成功；
Codex MCP 的 `status === 'failed'` 即使 `error` 为空也保留为工具错误，显式 `error` 同样如此。
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

此前 #1658 候选在实例接收身份后，注册和 claim 期间异步只读预取已选官方 CLI 软件。
该假设现已实测，后续 #1660 停用 daemon 默认调用，保留独立实验函数和其测试供复核。
不以“只读且无远程请求”推断它能缩短启动时间；bootstrap 一次 publish/wake 与 fresh
授权读取优化不受影响。

2026-11-07 的[匿名对照原件](../research/2026-11-07-e2b-cold-prefetch-control.json)
来自 [Actions 42403752740](https://github.com/alexj11324/Mikka/actions/runs/42403752740)：
固定 d75 发布及官方派生模板，8 个 fresh VM、两种 CLI 每臂各 2 次、平衡次序，
control 与 prefetch 均有 2 秒准备窗口。只做 Claude SDK prewarm 或 Codex initialize，
没有账户登录、claim、用户 prompt 或模型调用；官方 CLI SHA 和版本在计时后验证。

| 初始化毫秒 | control | prefetch |
|---|---:|---:|
| Claude Code | 2260.151 / 3129.288 | 2341.121 / 1026.186 |
| Codex | 1049.070 / 618.395 | 2033.094 / 3811.812 |

Codex 两次仅读到 9154 字节 launcher，均为 partial，native 文件未读；因此不是有效的
native 预读对照，也不能以每臂 n=2 将变慢归因为预读。Claude 两次读完同一 290532720
字节文件，耗时 2915.832 / 1670.389ms；前一次与初始化重叠，收益仍不稳定。provider
物理页缓存和后台 HTTP 未完整观测，保留 unavailable。全部 8 个 VM 已回收并按实际 ID
读回 404，独立最终 ownedSandboxesAfter=[]，临时 ops ref 删除成功。
原始 report.json 为 19019 bytes，SHA256
`5296d17e7c612b481b98ed0bd92110cdaa85525efeb46d1eccf5fabf6f1ddcca`；
artifact ZIP 的 SHA256 和固定 helper/release 元组随原件索引保留。

这组匿名初始化时间不计入完整 dispatch 验收，也不能替代两条真实订阅发布 gate。
下一候选仍须新的同版本 Claude×3、Codex×3 完整生产验收，当前 #1505 未达标。

本记录保留早期 #1131、#1124 的官方文件保护要求，并取代其中禁止派生模板的
解释；独立的官方机器种类和所有者绑定凭证规则保持有效。

## E2B 构建行为依据

[E2B 模板构建说明](https://docs.e2b.dev/template/how-it-works) 和
[start/ready command 文档](https://docs.e2b.dev/template/start-ready-command) 说明：
start command 在模板构建末尾执行，ready command 成功后保存文件系统与内存状态；
新实例从这个已就绪状态恢复。因此只预加载无身份的 worker，实际 owner、设备与任务
通过启动后的正常 handoff 注入，不依赖创建实例时的环境变量去更新冻结的进程。

### 2026-11-07：统一发布后的后续验证边界

#1658 的固定 head 6d7d993a 已随统一发布 #1615 正常合入 main 4672c418；
源码合并不代表生产发布或 5 秒验收完成。后续查询优化以该批次为基底，保留其完整 run failure、
continuous tracing、critical request sampling、授权与撤销行为，不用旧版本整文件
覆盖。额外限定窗口 sampler 方案未采用，因为统一批次已提供原生 critical 采样；
后续先验证实际部署的链路覆盖，不增加第二套 claim 授权或采样入口。

全部六次完整生产失败记录仍保留。只有同一最终部署、worker/source 和三个模板
组合的 Claude 三次及 Codex 三次完整 dispatch-to-agent 均不超过 5000 ms，且原有
官方文件守恒、真实订阅和清理门槛均通过，才可关闭 #1505。匿名 CLI 初始化对照
只用于判断文件预读取假设，不能替代这项生产验收。

### 生产函数区域与数据库区域证据

后续候选在原 production-only Web deploy 的 prebuilt 上传参数加入
`--regions cle1`，普通 main 与 runtime paired Web 共用该上传入口；不改社区发行版、
独立 cloud backend、数据库或 E2B 区域。Vercel CLI 65.4.0 的实际 prebuilt
上传实现已核对会发送该参数。[官方区域表](https://vercel.com/docs/regions) 将
`cle1` 映射到 AWS us-east-2，匹配当前 Neon production 项目的控制面区域；
既有配套部署的控制面区域为 `iad1`。

此前 PgInstrumentation 0.76.0 使用 `server.address`，原脱敏器会删除该字段，
所以历史 span 不能证明实际运行时数据库主机与上述 Neon endpoint 的对应关系。
不把项目元数据或 build-time URL 当成历史 runtime 证明。后续仅从现有 PostgreSQL
span 的主机属性派生闭式 `mikka.db_peer_region`，只识别 Neon 的 aws-us-east-1 /
aws-us-east-2；端点、账号、URL、口令和原始 `server.address` 仍不导出。
未知地址、非 PostgreSQL 及调用者自带的区域标签不作为区域证据。没有新增 SQL、
主机探测、轮询或授权请求。

该部署位置变更是待实测的延迟优化，不预先计算节省毫秒。发布后同时核对实际
READY 部署/函数区域、公共版本，以及本次真实任务 trace 的数据库区域与各段时间；
若实际 placement 不符或完整耗时恶化，就通过普通后继 PR 恢复原部署参数。
5 秒门槛、原始起止点、六样本分母及官方双订阅门槛保持不变。

### 注册完成通知与维护刷新

后续候选在 daemon 完成原注册响应及凭证/工作区轮换检查后，才原子写入私有
registration.json。收据绑定 device、workspace 与本次凭证摘要，不携带凭据。
服务端在同一原有发布命令中先安装文件事件 watcher，再发布 bootstrap 和可选
sidecar、唤醒原 worker；缺少 preloader 时保留原后台启动及实例内日志。
文件类型、属主、权限、大小、键集合与绑定均严格检查，不增加正常数据库轮询。

只有被安装 source 自己的 build-cloud-worker 脚本才能产生注册通知能力文件。
installer 先核验 source 与 worker digest，再向该版本构建脚本传入身份；新 installer
不能给旧 worker 声明不存在的能力。能力文件随 release/source/worker 一起切换，
缺失或错绑时立即保留原数据库等待，不先等一个通知超时再回退。

通知不代替数据库授权。最后按既有 run → machine 锁序取得锁，再在下一条语句
fresh 检查 lease、stop、设备归属与实际新凭证使用状态。这样既能看到锁等待期间
已提交的撤销，又不反向取得 token 锁。运行中任务仍要求 stop 为空。
合法的终态维护刷新单独绑定入口与当前 terminal status、PostgreSQL 原始 stop 文本
以及历史 stop 对应的 native exited 证据；两次最终检查继续核对相同绑定。
精确 stop 文本保留微秒，不经 JavaScript Date 截断；新增 stop、重排、证据撤回、
租约变化及已结束机器均拒绝，不修改历史停止记录或扩大任务领取权限。

正常成功路径不再提前查询用于日志遮罩的秘密；实例日志仍保留，失败取回尾部时才
按原规则遮罩。正常 BYO E2B 成功路径必须能解密 owner 的 E2B key，因此具备原
遮罩器要求的加密配置。四条必经遮罩查询按空结果保守计量，成员非空时的额外查询
不计节省信用。注册相关差异的真实 PG wire 对照计入最终事务全部四条 SQL：原路径
8 条 / 4428 字节，通知路径 5 条 / 2427 字节，旧 worker 路径 6 条 / 2934 字节。
其他未改工作两侧同样省略；此表不是整次任务的 SQL 总量，也不是 TCP/TLS 费用
或时间收益。密钥缺失会在正常 provider 调用前拒绝，不靠平台 fallback 满足前提。
维护的两个已有 SELECT 为精确 stop 增加投影；其本身的额外成本及完整成功维护
的净账分别记录，不能把成功路径信用外推成每个提前拒绝分支都没有增加字节。

### 启动准入的配额读取

启动模型准入继续在原 requester/member/share/owner 与 epoch 边界调用 custody，
但使用专门的 Allowance RPC，只读取所需的 provider quota。Claude 不再在这个
启动入口追加 Settings 的账户资料 HTTP；Codex 仍使用原同一次额度响应。
原 Usage/Settings 实现不变，执行租约入口与撤销行为不变，不缓存先前授权或额度。

配额保存仍是原 epoch-fenced UPDATE。新响应没有有效套餐时，在同一 UPDATE
保留数据库当前 plan，而不是请求前读到的旧值；Codex 即使返回已知 plan_type，
没有有效额度窗口时也不能擦掉原套餐。启动路径不写账户标签。
SQL 次数相同不足以证明数据库预算相同：动态候选可以包含多个账号，所以逐次
保存的 SQL、参数及响应字节必须与原路径对照，不能以固定注册节省量无条件抵扣
任意数量的候选。完整证据索引记录该预算修正与实际 PostgreSQL 对照。

启动额度刷新继续执行原来的 fresh readyAuth、连接 epoch 和最终回读；Settings 的完整 Usage 行为保持。保存启动 quota 时，只把 plan 合并为 UPDATE 实际锁定的当前数据库 plan，不能使用 provider await 前的旧 row 覆盖并发 Settings 修改。该分支使用 228B 静态参数化 SQL；普通 Settings 的 230B SQL 原文不变，四参数、owner/id/epoch/connected 谓词和 previous 返回快照不变。隔离 PostgreSQL 18.6 的真实行锁对照确认原 CTE 与内联 SELECT 在并发 plan/epoch、missing/SQL-null/JSON-null 与通知判定上等价；EXPLAIN 表明旧 CTE 本来已内联，不主张数据库扫描减少。实际 PostgreSQL 请求字节在相同四参数时为 580→578B，响应相同；若旧 plan 为空字符串、新 allowance 为 null，参数最多 +2B，恰由 SQL -2B 抵消。因此该写入可以按任意候选 N 逐项计账，无须用其他阶段的节省掩盖 +65B。这里是本地协议字节与语义验证，生产时延未测，PG17 精确 CI 仍为必需门槛。

### Bootstrap 后的无账户 Claude 初始化

仅实际新建的官方 Claude TaskVM、首次 queued 仓库任务可以携带准备提示。
保留实例、已有设备/session、重试、续作、问题恢复和 runtime refresh 均不适用。
提示与 bootstrap 的完整字节摘要和 run 绑定，随同一次上传及原子发布交付；
不含可用账号或任务权限。匿名原版进程只在实际 bootstrap 接受后创建，每实例
生成独立 session UUID，模板 snapshot 不保存这种带 session 身份的进程。

注册和 claim 可以与该初始化重叠。真正采用之前仍完成 fresh claim、原租约、
policy、Skill、仓库与 session 检查，并精确匹配设备、工作区、模型、effort、环境、
诊断范围及完整工具目录。普通 HOME、Git、gh 和 user/project/local settings
保持原行为。完整 MCP backend 由原 stdio 入口和新桥接共同使用，可能阻塞的 Git
handler 放入本任务拥有的子进程；未绑定时拒绝业务调用，撤销时关闭并排空进程。
没有跨任务进程复用，也不以提示或工具目录授予业务权限。

准备进程只能采用一次；不匹配时先完整关闭再走原启动。只有官方 SDK 精确的
project_settings_not_claimable 才允许 claim 后、用户输入前关闭并同 session
回退；其他账号、权限或绑定错误保持失败。新领取的 OAuth 只在 claim 后交给该
原版进程。账号检查保留原 firstParty 与非 API key 条件；新增的精确环境 OAuth
来源只在成功采用这条候选路径时接受。

显式诊断保留真实提前开始的 collector 与时间轴，source 为 bootstrap_claude_start，
不把它塞进晚开始的 agent_start 或平移起点。observedAuthSource 来自原生
accountInfo 的实际值；只设置 Claim.env 不能生成通过证明。采用匿名进程时，未知
认证来源不能通过该路径的严格 reader；普通回退仍执行原账号检查。两条路径的缺失
初始化、错绑或不完整 exact ACK 都不能通过。普通任务不添加
详细持久化诊断字段，派发入口、六样本分母和 5000ms 判定公式不变。

已安装 SDK 0.3.305 的真实进程/IPC 离线回归只能证明协议与拒绝边界。0479675 已发布的真实
订阅候选 gate 使用 personal acceptance daemon，继续验证原 FD3 路径；它没有
bootstrap sidecar，因此不能证明新的匿名采用及环境 OAuth 来源。原有官方文件
保全和双真实订阅 gate 仍是发布门槛，新的实际采用与耗时还必须由随后相同最终
部署/worker/source/模板元组的六次正式生产任务证明。

本轮各切片、合成检查和预算边界见
[候选证据索引](../research/2026-11-07-e2b-startup-overlap-candidate.json)。
这些实现与本地结果均未被记作五秒达标；生产未通过前 #1505 保持打开。

### 0479675 后继本地候选：Codex 初始化与凭据批次

本候选以已合并的 `0479675e188efeac341b207d8616c4d7b9d4ee23` 为基底，
合成尚未发布的 Codex 匿名初始化与凭据准备五写批次。基底已合并不代表线上已包含
这些后继改动。原版 Claude、Codex、desktop 文件保全、fresh receipt、双真实订阅
及同源发布元组门槛全部保留，没有新的模板快照内 native session 或已分配 VM 池。

新建、从未领取任务的 Codex 实例只在接受 bootstrap 后创建独立原版进程，
匿名阶段发送 `initialize` / `initialized`，不登录、不建 thread、不发送用户输入。
随后必须经过原 fresh claim、lease、policy、真实 checkout 与完整配置资格检查，
才允许一次采用并执行原有 login 和任务流程。正常 HOME 和真实 Git worktree 不变；
项目配置、版本或绑定不适用时先排空，再走原启动路径。详细边界见
[1800 决策](2026-11-06-1800-machine-is-the-execution-boundary.md#bootstrap-time-anonymous-codex-initialization)。

凭据准备只把同一事务内原五条 DML 的传输合为一条 PostgreSQL simple-query
消息，仍执行五条有序语句及后续 fresh rebind；不把一次往返写成一次 SQL。
精确新凭据时钟仍来自最后 INSERT 的 `clock_timestamp()`。本地协议量正常样本
从 1788 B 降为 1466 B（−322 B，不含 TCP/TLS/建连）；高膨胀值保留原参数绑定
路径。早期 SQL 失败可能多发送尚未执行的后续文本，首错截断与整笔回滚保持，
实际错误前缀账单独保留。

[本候选紧凑证据索引](../research/2026-11-07-codex-initialize-five-write-candidate.json)
区分原固定提交的验证、合成后的交叉验证和未完成的生产证明。既有 0.166.0
匿名协议控制没有账号、thread 或 turn 请求；它与本地数据库/类型结果都不能
替代新候选的真实订阅采用或 dispatch→ACK 五秒成绩。本候选没有新增生产样本，
没有把协议字节节省计作 ready-pool 已获预算。

### 78c3c13 生产失败后的采用修正

生产 run 42430097946 的六个原样本仍保留失败：Claude/Codex 交替的 dispatch→ACK
分别为 18845.698、15448、16510.477、14497、14408.969、17929 ms，全部超过
5000 ms。39 项服务端阶段齐全，但第 4 个 Codex 样本只有工具完成、没有工具后的
回复，故缺少完整执行证明；原 driver 跳过其 closing pin，实际只有 13/14 次 pin。
这些记录不能改写成完整 pin 覆盖，也不能因后续本地修复追认通过。

三个 Claude 样本都走了 ordinary_path，实际认证来源为 oauth_descriptor。
实际 worker/hosted runner 环境的回归复现了两个严格比较差异：匿名启动缺少
supervisor 生成的 MIKKA_RUN_ID；官方 SDK 首次调用又同时为真实 child env 和
process.env 增加 CLAUDE_AGENT_SDK_VERSION，而匿名 options 的快照早于它。
修正只加入绑定 hint 的 runId，并从官方 SDK 本次实际 spawn config 同步这个
版本字段。完整环境、fresh claim、认证来源、临时目录、单次采用与关闭排空校验
均保持；不能通过忽略字段或写死版本号来允许采用。冷 SDK、真实 hosted runner
与不同 runId/版本拒绝均有离线回归；它们不是生产采用或五秒达标证明。

后继 driver 在 initial pin 成功而 closing pin 尚未尝试时，即使执行证明失败也
补做一次 closing pin，保留原执行错误。closing pin 失败另行记录，清理后中止
后续派发。正常成功路径的 pin 位置、14 次总数、完整执行证据和 5000 ms 公式
不变；原 13/14 报告不修改。

另有可独立重放的 Codex 协议边界：空 agentMessage delta 原先会把 item 标为
已输出，使随后 completed item 的完整文字被丢弃。现在空 delta 不占用该标记；
非空流式输出与完成消息去重保持。离线真实 adapter/fake-native 回归先失败再通过，
但没有保留上述生产第 4 例的原生通知流，因此不能把该边界认定为其已证实原因。

[本轮失败与修正证据索引](../research/2026-11-08-e2b-adoption-correction.json)
区分原始生产失败、源代码复现和后续待完成的发布/生产验证。官方文件校验和、
Claude/Codex 双真实订阅及最终同一部署元组的全部六次五秒验收继续作为门槛。


### 生产关键路径与后继的请求重叠

固定 78c3c13 / run 42430097946 的 16 个不重复区间与原完整公式逐例相加一致。
本批注册与 claim 的实际重叠为零。单独扣除整个 ensure 的账面余量仍为
8.780–12.913 秒，因此不能把预热 VM 的局部收益推算为五秒通过；该扣除也不是
预热池的因果预测。实际阶段与原件摘要见
[关键路径及后继候选证据](../research/2026-11-08-e2b-startup-roundtrips-candidate.json)。

仅对可信 bootstrap 携带的首次 hosted 仓库任务，daemon 请求把原 claim 已读取的
仓库设置放入同一最终响应。服务端仍先通过原 fresh 响应栅栏；daemon 仍先处理
heartbeat、撤销、凭据轮换、卸载及 checkpoint，再采用准确匹配 run/device/repo/remote
且 schema 有效的一次性设置。它替代该次 listRepos GET，不增加发现或授权查询，
也不写入恢复 journal。旧服务端、缺失或错绑投影、本地设备、续作等保留原 GET。
设置的一致性时点是原 claim 的读取；不能声称与稍后第二次 GET 对并发编辑的观察
时点完全相同。旧服务端首次 GET 现在等待这次 claim 回应后回退；取消仍须中止
claim 并排空，不能用等待顺序变化掩盖相互等待。

真实隔离 PostgreSQL 的受影响正常 Task 切片从 9 条 SQL 降为 1 条；缺失/完整设置
返回行分别从 5→0 / 7→1，实际 PostgreSQL 双向消息分别减少 3173 / 3278 B，
Unicode 大设置场景减少 5077 B。旧 claim＋repos 的 JSON 响应体总量比新 claim
多 4 B。完整 Task 是未改变的共同前后缀加该切片；这些不是整个 Task 的绝对
查询数或 HTTP/TCP/TLS 总量，也不代表生产毫秒收益。

下一轮 Git 细分仅沿用已有任务或可信 host 的显式诊断 opt-in，记录 clone、fetch、
remote HEAD、refs 和本地 Git 的闭式阶段；标签只有 run hash 与 harness，不记录
命令、远端 URL、路径或凭据。默认执行仍直接调用原 execa，参数、环境、取消和
超时不变，没有新 SQL、HTTP 或产品轮询。首次并行局部验证的一个子进程排空断言
曾失败；原日志保留，未放宽断言。随后同断言隔离通过，旧源码 30/30、新源码
33/33 顺序完整套件通过；这不足以把原失败武断归因为已证实的旧抖动，合成 CI
仍必须重新通过。该诊断不增加正式 39 项门槛，也不改变派发起点或 ACK 公式。


### 提前建立、确认上传后才提交的 worker broker

仅新建仓库 TaskVM 尝试提前启动自有 broker；官方文件、旧 worker/refresh/desktop
的执行边界不变。loader 验证所选 release 的目录所有权、symlink、worker 标记、
实际构建能力及 broker 完整字节 SHA 后，才执行 /opt/mikka 内的资源。准备阶段
不含账号凭据。原 fresh 凭据事务提交后，仍用原 multipart 请求完整上传 bootstrap、
initial run、Claude 和 Codex 四个文件；只有上传响应成功，才通过已经打开的 E2B
输入流发送一次长度/摘要及 run/lease/device/workspace/token hash 绑定的 commit。
完整原子发布、以 user 身份唤醒、旧启动回退、真实匹配注册通知和最后 fresh SQL
栅栏保持。文件部分写入或上传结果未知都不能发布。

这将后置连接和进程启动提前，不减少正常请求总数：旧、新、legacy 三组均为
3 请求。实际 SDK 2.61 loopback 的 HTTP 请求行/头/体与响应头/体为
11796→10847 B（−949 B）；legacy fallback 为 17913 B（+6117 B）。不包含
TCP/TLS、HTTP2 或 chunk framing，且不是生产省时证明。136 个现有 SQL 调用点
的完整文本不变；未引入数据库查询、额外数据库写入或产品轮询。

预提交等待、提交后的发布与注册均有独立有界期限。取消通过独立输入流有序发送；
send 只排队，close 的确认才证明输入传输完成。响应流断开不等于进程已退出。
提交后若输入流也不可确认，保留失败和原 TaskVM recovery 的清理责任，由有界
broker 排空其发布子进程；不能只杀父进程后宣称干净。实际进程取消、上传 ACK
丢失、凭据撤销、错绑/损坏文件、老版本兼容与真实 PG 路径均有回归。
[broker 候选索引](../research/2026-11-08-worker-bootstrap-broker-candidate.json)
单列正常预算、失败不确定性和旧版本开销。

### 实际 bootstrap 采用成为双订阅发布门槛

本后继把候选测试接到模板内真正的预载 cloud-worker：先用原注册流程登记候选
个人设备，暂不 claim；保持原 push socket 在线，正常 Coordinator 为共享冒烟身份
创建新的只读仓库任务，再由 owner evidence 的显式 opt-in 投影生成 canonical
提示。投影核对 run、owner、device、workspace 和冻结 execution identity，复用
原 hint builder，不携带任务凭据或授予执行权限。默认 evidence 的原 SQL/JSON
完全不变；额外投影仅属于这项明确开启的候选诊断。

辅助脚本来自固定候选 source 的 /opt/mikka 安装，并进入 worker recipe hash，
不是 runner 临时注入的替代 worker。它保留 VM 内原 bootstrap 凭据字节，先发布
一次性 sidecar，最后独占发布 bootstrap，再唤醒实际 dist/cloud/cloud-worker.js。
该进程执行原正常 register、fresh claim、租约、policy、仓库与账号边界。
helper 的运行依赖从实际安装的 daemon 包作用域解析，不能依赖未安装的根依赖。

发布 reader 要求同 run/harness、恰好一次成功 prewarm/init、真实 bootstrap
source 及未截断的原时间轴。Claude 另要求实际 accountInfo 的 oauth_environment
与 claim 来源一致，ordinary FD3 回退不能通过。Codex 的 preparation receipt
只在真实采用成功后可见；初始化成功而项目、环境或身份拒绝采用时保持缺失。
Node 验证器、Python release verifier 和最终环境发布都重复核验该证明，官方
三模板文件校验、双真实订阅、工具后的回复和官方 exact ACK 继续保留。

这是候选真实采用门槛，不能替代正式 cloud-kind Task 的端到端验收。历史 047
个人 acceptance daemon 的 ordinary 路径成绩仍保留，不能追认为采用成功。
本地 166 项 Node、Python 32/22/16、25 项 daemon、21 项真实 PG 与类型/lint
只证明候选实现及拒绝边界；仍需最新合成 head CI、生产真实双订阅和同一最终
app/deployment/runtime/worker/三模板的全部六次完整派发 ≤5000ms。


### GitHub 身份与第一安装页的同 token 读取重叠

原 App 配置和唯一一次 fresh user token 取得后，/user 与第一安装页并发读取。
两者全部结束后仍先检查 /user 的原错误、合法 ID 和绑定身份，再处理安装结果；
本 App、suspended、用户 explicit 仓库交集和后续分页顺序不变，不换成公开 repo
GET，也不并行 model/Profile/queue。第一安装页只消费一次，正常本批仍为三个
GitHub GET，SQL 和 token 刷新次数不变。

身份拒绝时可能已经多发一个只读 GET（失败前缀 1→2）；快速身份错误也可能
等另一请求的原有 10 秒截止。原错误优先级和排空保持，不声称失败等待完全不变。
请求累计 github.ms 在并发后不能作为墙钟耗时再相加。35 项原 transport/fetch
回归通过；生产节省多少时间仍待新六例测量。

### 合成验证与主干依赖变化

合成后的本地验证包含：发布 Node 168 项、cloud limits 105＋11 项、GitHub 35 项、
真实 PG Task 121 项、bootstrap 投影 21 项、完整 heartbeat 2 项及 daemon 142 项，
均通过且无跳过；应用/API/daemon 原类型门槛、65 文件显式 lint 同时通过。
缺失本地 semver 依赖链接、误用空测试库和旧构建证明脚本中的 probe 文件名错误
均保留原始失败日志，分别修正环境/使用完整迁移和核验真实产物；没有修改业务
断言、降低门槛或把缺失 schema 当成产品结果。

随后正常合入主干 3c32675 的 trusted affected CI。它的锁变化使 worker 指纹变化，
原因是 Vitest/Vite 新解析了 YAML 2.9.0 可选 peer；183 个生产 package/snapshot
内容与旧锁相同。另在 b75 隔离树用 pnpm 10.34.3 实际 frozen filtered install、
cloud build 与资源字节核验通过，worker 为
73be9136ba4b51af098403074f35fc5eecb58fb2。开发 Node 24.22.1 与模板 24.19.0
不同，因此这仍不替代新 head CI、真实 E2B 和双订阅门槛。最终待生产六例的完整
派发结果，不将上述局部测试或固定指纹当作五秒成绩。

### 最新完整 CI 的桌面 claim 断言校正

远端 fb77f62ad17d98a21e2798c04d7e9a2cfe0c2e8e 的新 trusted selector 实际选择完整
85 个 unit task、70 个数据库 suite 与四个 PG shard。其 Node 22 和 daemon 两个
job 暴露相同的两条桌面 owner 测试错误：新增可选 repository capability 为
undefined，但旧断言仍只期望三个参数。仅将该断言的第四参显式写为 undefined，
原 device、run、AbortSignal 和 start 断言全部保留，未改变产品路径。

真实同版本 Node 22.22.1 下，原完整文件 34 通过／2 失败，修正后 36/36 且无跳过；
两条原 CI 红灯及原日志保留，未把该文件的通过当作全套 CI 已通过。该测试文件
属于既有 worker 指纹输入，故后继 worker 为
fc49a8b4933ba6216cc0ebf5b2c941b43fd2144b，不能沿用前版 73be 指纹。已以相同
受验证锁文件依赖实际重建，两入口、九资源、16 个夹具、资源模式和 12 项语法检查
通过。本地产物验证器首次对自有依赖 symlink 路径的记账错误也保留；仅按实际目标
修正记账，没有改变资源或产品断言。详细证明追加到同一候选证据索引；仍须新
合成 head CI、三模板守恒、真实双订阅与全部六次生产五秒结果。


### 单次成员读取、锁内 run 复用与采样隐私

2026-11-08 的后继本地候选去掉 authorizeSubscriptionWorkspace 中仅包围一条
SELECT 的显式 BEGIN/COMMIT。原 UUID 校验、参数绑定、完整成员条件、FOR SHARE、
LIMIT 1 与缺行拒绝保持，每个原调用点仍重新查询，不合并两人的授权快照，也不缓存
前次结果。真实 pg 只有在 ReadyForQuery 后交付成功，查询、提交或连接异常不能
因为已收到一行而授予权限。原函数没有持锁跨越的业务操作；两种实现都可能在数据库
释放锁后、调用者恢复前遇到撤销，后续 fresh claim/lease/response fence 继续保留。
原独立 BEGIN/COMMIT/ROLLBACK 的故障阶段被移除，不声称所有基础设施错误完全同形。

真实隔离 PostgreSQL 18.6 对照中，单次正常校验从 3 条 SQL、3 次发送、585 B
变为 1 条 SQL、1 次发送、527 B；数据行仍为 1，没有 DML。缺成员拒绝为
544→482 B，仍不执行下游。原绑定查询支持的空、Unicode、引号、长身份等不增加
限制。实际双连接覆盖撤销持锁后提交、锁释放后撤销以及仅终止测试自身连接时拒绝。
已有 Factory 测试夹具增加对同一隔离 Drizzle 实例的 select 绑定，原 transaction
绑定及 PostgreSQL 17 版本门槛保留。PG17 全套结果仍由新精确 CI 提供。

claim 的 Profile 准入另外复用同一事务刚取得 FOR UPDATE 的 run 行，避免马上重复
读取同一行。外部调用者保留原自行读取入口；该锁与准入之间不插入业务 await 或写入，
Profile 来源、凭据和最终响应栅栏保持。在固定本地 acquisition/claim/终态夹具内，
SQL 170→169、返回行 114→113，Claude/Codex 实际协议量分别减少 306/305 B。
这是受影响完整夹具，不是实际 provider/model Task 总量。更宽的锁定投影使
stop-before-lock 的失败前缀增加 1367 B，单列保留；不能把正常净节省外推到每个
拒绝前缀。

五写批次的复核还发现，现有 egress sampler 会把 SQL 字符串中的 “from 模块名”
识别成表名。资格检查因此对最终转义文本的全部有序匹配做精确核验，不截断或去重；
任何额外匹配，包括重复的已知表名，都恢复原五条参数绑定语句，值不改、不拒绝。
正常 pnpm test 仍为 1466 B；特殊命令恢复到原安全路径的 1831 B，五个首错前缀、
SQL、参数和回滚结果相同。旧不安全批次的 1509 B 不再记作该场景的节省。
全局 sampler、采样开关和正常诊断预算不因这个修复改变。

[该批次证据索引](../research/2026-11-08-e2b-membership-and-claim-candidate.json)
绑定三个独立候选及本地完整合成源。随后正常合入 main 9e18 的 task-secret
capabilities：新增资源 snapshot/attempt/device-token/workspace/repository fence
完整保留，初始仓库设置仍只在该最终响应栅栏内同步投影。受保护 Secret 的动态
taskSecretEnv 仍参加完整环境匹配；不适用匿名接管的任务保留正常启动，不能忽略
环境差异来追求时延。这里记录本地验证和兼容边界；新 worker 的构建、精确 CI、
真实模板/双订阅发布及全部六次正式生产计时分别取得证明后才能记为通过。

完整前序 #1683 的 beab 交付另在本方分支合成为 e7c 源，不替代其 owner 的独立
合并及发布。两个文本冲突分别保留双方测试入口，以及 Codex 已采用进程不重复
initialized 和恢复必须匹配实际 native version 的检查。新组合实际通过启动/Web
114 项、daemon 110＋23 项及 app/API/daemon 类型检查；实际 worker 为
5343beb10c58d3f68a9238a3bca1c24a8546d722，两入口和全部运行资源验证通过。
先前 e420 的 PG95＋源码夹具36、daemon218及 worker6ded 仍单独绑定原源。
app 首次缺少 Electron 的类型依赖错误保留，仅链接既有锁定版本后复验；未改产品
或断言。本地 Node24.22.1 与模板24.19.0 不同，以上仍不替代新精确 CI、真实候选
订阅采用或正式生产五秒结果。

完整前序随后更新至 `49527b7da0f4ef4791e5bb108c2f83114f150b56`，仅在隔离的
self-hosted-image CI job 中，服务验收后、安装源码依赖前清理中间 Docker 构建缓存。
本方正常合入该完整提交；除这项 workflow 和本条证据文档外，相对 e7c 的所有 Git
blob 完全一致，worker 指纹保持 5343beb。既有本地验证仍绑定原源，不追认为新
head CI；新远端精确 CI 和真实生产门槛继续分别等待实际结果。

## 2026-11-08：完整上游合流与 Git 分段收据（生产待验）

本轮继续保留完整上游历史：#1688 的 `ec332cb34678e6638931e9b4ad1e9f893b3b303c` 已包含 #1705 的 `cf456f02c643d4e6074ccd7db2f7cee5b32e4f4c`、两处协调器修正和凭据清单分页修正；随后正常合入实际 main `263e7ea37013bd22aa197799a26f1d2e0d1abbf1`。本地产品源 `8870fbf4f97b415386a1b150f2df934f04f269e5` 与合入 main 后的 `ec1dc7dd9cf061f6a90fea372a32641b2db9a93b` 均为 tree `9b6fbdc4238cfc79ea492deda048d04b9c147211`，后一步没有改变任何文件。AGENTS.md 和 CONTRIBUTING.md 未改。本节及配套 [完整源码与 Git 计时证据](../research/2026-11-08-e2b-complete-source-and-git-timing.json) 是发布前验证记录，不能代替新远端候选的 CI 或生产成绩。

证据分别绑定实际执行源：旧远端 `06307cb8` 的 13 个工作流全部成功，50 项检查为 39 成功、11 条件跳过；实际 checkout 为 `c51b48c5`，不把后来同树的合成 ref 冒记为已执行。中间 `aac23ec2` 通过 115 项及三组类型检查，worker 为 `d0f47bcc`。Git 收据后继 `41219130` 实际构建 worker `915cd92e81e56388d8bb2ff19abc919b85ae80e7`，两入口、9 个资源、16 个夹具、12 项语法和 daemon 类型检查通过。最终产品合流 `8870fbf4` 实际通过启动/Web **116/116** 及 app/API 类型检查；其 canonical WORKER_PATHS 与 RECIPE_PATHS 共 **470 个 mode/type/blob/path 对象**逐字等于 `41219130`，官方 fingerprint 命令也实算为同一 `915cd92e…`。构建证明通过明确的输入守恒继承，没有虚报在新 head 重跑构建。开发 Node 24.22.1 与官方模板 Node 24.19.0 的差异仍由发布门槛覆盖。

Git 明细的原缺口已具体定位：`aac23` 的五类 Git 操作仅发 OTel span，正式 raw 没有收据。新增 `RepositoryGitTiming v1` 只在既有诊断 opt-in 中创建，沿原 `data-run-stage(repository)` **同一条事件**返回，不增加事件、SQL、行、HTTP 调用或定时轮询。普通关闭状态连新字段也不出现；原成功/失败事件和 `reportAfter` 授权屏障保持。observer 或计时记录失败不覆盖原 Git 结果或原错误。

收据只包含 run hash、harness、闭式来源/时钟、数值区间、outcome 与截断标记，标签固定为 clone、fetch、remote_head、remote_refs、local；不采集命令、路径、URL、环境或凭据。最多 32 条、收据值最多 8192 B；包含字段封装后，诊断开启时 stage 的 JSON 最多增加 **8212 B**。一个固定示例由 74 B 增为 423 B。这是非零的 UTF-8 JSON 载荷增量，不是完整 HTTP/TLS wire 测量；普通 Task 的默认载荷保持原状。

偏移只使用该次 `prepareRunRepository` 的独立单调时钟原点。覆盖范围是 `RepositoryCache.update` 的已有 Git wrapper；seed、push、baseRef 等其它动作没有被补成已测 Git 子阶段。总时长可能包含凭据或锁等待；区间重叠按区间并集描述，不与 repository 父阶段相加，不拿服务器 `storedAt` 推算 daemon 起点。driver 严格校验闭式键、标签、身份、数值和上限。重复有效收据继续保留第一份，状态取实际保留数据的截断标记，invalid 保持黏性；原 `8df3` 中重复状态不一致的发现和真实 RED 已保留，由 `412191` 修复。

这次只增加可选诊断。原 dispatch 到 ACK 公式、39 阶段、版本 pin、真实 native/tool/post-tool 证明与清理门槛保持。reader 内联在原 driver，未增加 import。正式 workflow 仍 checkout 完整的准确来源；四项核心 source inventory 不是可脱离仓库运行的四文件包。七项 producer provenance 中只有预期的 driver 变化，canonical report producers 和原验收器不变。

上游预算也明确区分：有效订阅省掉无关 hosted-policy SELECT 是上游修正，Promise 只在单次 resolver 中复用；有效显式 API key 原本已在该读取前返回，不重复记减读。Coordinator 无名或歧义仓库发现仍可每次读取使用标记，完整授权列表也可能大于旧 50 条；不能假定模型绝不额外发现仓库。凭据清单分页会增加该列表操作的行和字节，带 cursor 的空页可能再读一次；它没有被这九文件 delta 接入 dispatch/ensure/claim 路径。本方完整正常 Task 的数据库预算以相同完整上游源和实际调用路径比较，不借这些条件性节省或未来任务抵扣。

官方模板仍只增不删，Mikka 文件仍在 /opt/mikka；CLI 文件校验和守恒、真实订阅采用、fresh claim/revoke/最终 fence 均保持发布门槛。原六例正式批次仍为 FAIL，原始报告、13/14 pins 及第 4 例执行/工具后证明缺口不改写。新的远端精确 CI、实际模板与双订阅 bootstrap adoption、配套 READY 部署和同一实际元组六次 ≤5 秒结果尚待取得。达到完整生产验收后才关闭 #1505。

## 2026-11-08 09:14 UTC：发布阻挡的修复和下一轮 CI 诊断（生产待验）

本节继续 #1505 / #1689，不改写前述失败记录。合流后的产品源码为
`12708943792632cc8c4eff8170692081d45b66ea`，完整保留 #1719 的
`a1d1578b83f73f7511479869a82da2ffd345a294` 及其 `844b3e5`、`780ebaac`、
`8bceef7` 祖先。后续发布以实际远端新 head、完整 tree 和 CI 执行 checkout 为准。
结构化证据见
[`2026-11-08-e2b-release-diagnostics-and-ci-wire.json`](../../research/2026-11-08-e2b-release-diagnostics-and-ci-wire.json)。

### 原 CI 失败继续有效

[CI 42461514081](https://github.com/alexj11324/Mikka/actions/runs/42461514081)
实际执行 checkout `63c981158675dc2b63fd6a4dcb160a42e060fa1a`，
tree `76143bea3227aeb72375e89ae29c6545cefdaf8d`；关联 PR head 是 `5c4ad8f`。
`unlinkedRunCitation` 的 9 条 SQL、932 字节 JSON 行和451字节 action 未增加，
但实际 socket 入站3244、出站6579，合计9823字节，超过冻结的9326预算。
后续 build gate 因该 DB shard 失败而失败，不能据此另称编译失败。

同一完整源码在本地精确 PostgreSQL17.11（Debian17.11-1.pgdg13+2）上，
仅执行原15文件 activity脚本，56/56通过；该 case 实测2639/6337，合计8976字节。
差额605/242恰与本地新 SCRAM 连接相同；本地另一个 warmup 的两次新连接也解释了
1210/484增量。**原 CI 没有连接追踪，这只能支持候选机制，不能追认原始因果或冲销失败。**
本地 Node24.22.1、2vCPU、未运行其他并发DB脚本，与 CI24.22.2 /
availableParallelism4不同；诊断包装也可能影响调度。

下一轮必要源码批次的 CI 只在既有 `MIKKA_READ_METRICS_TRACE=1` 下增加最多32项匿名
socket计数、是否新建、当前测量的query数量与截断标志。global totals、
ALS SQL/row计数、返回对象、原await位置和query callback/Promise体保持原样；
没有新增等待、网络、SQL或参数/结果/凭据日志。fixture、warmup、测量边界和9326断言均不改。
它是诊断增量，**不是已证实的产品修复，也不是重跑旧 head 来隐藏失败。**

### 发布构建与权限路径

完整上游 `844b3e5` 仅在已有一次性 Linux Web build runner 清理三个固定闲置SDK目录
（Android、.NET、GHC），并仅在build step设置4096MB Node old-space和记录容量。
这是每个 Node 进程的 old-space 上限，不是主机总内存限制；不涉及官方E2B模板文件。
正常build、类型检查、迁移、main检查、发布权限及最后有效runtime保留规则不变。
受控私有构建成功的边界由其
[公开回执](https://github.com/alexj11324/Mikka/pull/1719#issuecomment-6719540665)
说明；它不替代正式生产发布，也不能证明已遗失原始日志的263生产失败同因。

我方进一步复现：子进程status=1、无spawn error、受保护日志含ENOSPC时，
旧公开回执遗漏了该码。新增独立 `observedSystemCode` 只接受已有封闭系统码，
从 `code:` 属性或 `Error: CODE:` 头读取；
`processErrorCode` 仍只记录启动错误。观察码不等同终止原因，
未知值保持null，不公开原始行、message、path或stack。
旧实现真实RED、修复后相关59/59测试GREEN；build/migrate/CLI guards逐字不变。

`8bceef7` 的lease-audit显式执行模式修复及离线依赖解析随完整历史保留：
只有显式leaseAudit允许其既有Python/tool回执，普通六次启动验收仍保持原readOnly路径；
不能把本地策略测试写成真实租约生产通过。
`a1d1578` 仅对Nitro测试自有临时目录删除增加最多3次重试和线性延迟，
原断言和60秒超时保留；不是整个递归清理600ms硬截止。

### 发布和验收仍未完成

本批没有削弱官方文件守恒、两条真实订阅及实际bootstrap adoption门槛，
没有修改启动计时公式、39阶段、15 pins /14次实际检查或6个样本分母。
新生产tuple、正式run和六次耗时仍为空；原六次FAIL原件继续保留。
必须等本批实际最新head CI、正式Web/E2B发布及资源清理满足原门槛，
再以同一实际tuple执行Claude×3和Codex×3，全部不超过5000ms并具有真实工具和后续回复。
完成前不关闭#1505。

### 09:32 UTC 后继：官方 Electron 下载入口

本地正常合流完整 #1719 后继 `5761953f8f39aae8b6fddbe559a07420437d959d`，
得到产品源码 `702a490b9ca1a0023156cfa8a877854c1c23ec69`。
此前 a1 的 CI42465512653 中，Desktop job128684501953 与 Image job128684547811
均在同一固定 Electron45.1.0 linux-x64 ZIP 下载上真实收到HTTP504；
后续证据审计/聚合失败不能替代这两个首因。

该后继只给两条Linux CI安装入口使用官方GitHub release/asset API，
保留安装包内固定version/checksums和原安装器校验。API认证不转发到
仅允许的官方asset重定向域，签名URL及错误原文不输出；不引入镜像源或跳过checksum。
根侧4/4纯下载协议测试、实际两文件lint、语法、polling/error-cause策略通过；
没有为此重下二进制或声称新CI/native/macOS已通过。与前述完整worker输入无交叉。
`35cb728e` 只是上一预发布阶段准备的未引用Git对象，从未更新PR分支或触发CI；
后续以最终实际发布head为准。

### 2026-11-08 10:37 UTC：官方下载路径、实际入口更正与下一次CI取证

#1689的df0c/tree052c实际CI checkout为日志核实的2699（同树，parents main263+df0c）。11工作流全部终态：9成功/2失败；44checks为33成功/7条件skip/4失败。实际首错是两个CUA固定归档下载HTTP504、Apple打包HTTP504；另一个是Desktop失败引起的汇总拒绝。CUA checksum/tar/driver均未执行；Apple失败URL未记录，先前Electron下载100%不能确定随后失败请求。原失败保留。原unlinkedRunCitation本次9 SQL/932 B JSON/2639+6337=8976 B≤原9326 B；尾部是同次执行汇总，没有socketTrace，不能追认旧9823 B的原因。

完整合入833：单一Electron入口支持darwin/arm64，从锁定npm校验值种入builder checksum缓存，保留校验与API/CDN令牌隔离。6/6已有相关测试、实际两文件97规则lint和语法检查通过；真实builder消费的是合成缓存，不能记为真实macOS或生产通过。

**更正覆盖范围：da9只修旧scripts/e2b/bootstrap-desktop.sh，该文件不在470项canonical inputs，也不是正式入口。**此前把它称为正式bootstrap或指纹变化不成立，已在#1719评论6720281156公开更正。正式INSTANCE_BOOTSTRAP是packages/daemon/scripts/official-e2b-instance-bootstrap.sh，构建器从固定提交读取、复制到/opt/mikka/instance-bootstrap.sh，再按source/worker/kind执行。

e369+e132现已补齐正式入口的GH和desktop CUA两行：仅换同仓库固定asset API326964816/661455608+Accept，保留各自原retry3/connect20/max120、完整SHA、归档位置/tar/symlink/chmod，不搬旧脚本额外flags，不加凭据/helper/镜像或升级版本。CI两处CUA也只换传输。Linux CUA复用既有37,183,089 B完整核验；本方mac CUA53,208,248 B、GH18,151,686 B均匿名完整下载并与原SHA一致，未执行归档，自有临时文件已删除。真正的模板构建、官方文件守恒和双订阅门槛仍不可省略。

main759 E2B42470724724已真实失败：三种模板完成node phase后各四次HTTP504，没有gh phase。curl未打印URL；按精确759源码两个phase之间唯一GH curl归因至GH下载，CUA尚未到达。三候选删除、两次清理stdout均VM空/三名字absent/errors空，双订阅和新公开runtime为0。Web42470724754的Build步骤失败，最后观察标记为typecheck，不能据此确定最终失败子命令；公开事件无具体诊断码，私有详细原因和被mask值保持unknown，不推定为ENOSPC或网络问题。

正式安装器通过WORKER_PATHS的packages/daemon递归进入统一指纹，不是独立RECIPE_PATHS条目。a3→e132的470项中469项相同，仅该脚本变化；worker从915cd变为 **9da70595d61ab946a6b4644f7cb1eaeec1bccc3d**。最终a08源码已实际重新build并用原验证器通过2入口/9资源/16fixtures/12syntax；中间产物与失败原件保留。本地Node24.22.1与模板24.19.0仍有差异，不能据本地构建声称生产成功。

main759 CI另有revokedRunCitation：7 SQL/781 B JSON/2890+5657=8547 B>原7700 B，本次unlinked仍8976通过。旧helper无socketTrace，847 B差值不能直接认作握手。a08只给既有test:activity-actor-db加MIKKA_READ_METRICS_TRACE=1，原Node参数和15文件逐字保留；SQL、预算、warmup、起点、await、并发都不变。输出限匿名数字/至多32条interval及已有测试源码caller，不含SQL/params/行值/地址/凭据。同步诊断可能影响调度，启用它不是修复或追认旧失败。根package只投影packageManager/engines/pnpm进指纹，scripts被排除，因此a08的470项canonical inputs与e132相同，worker仍9da。

待发布组合635d9d7f/tree2a5a4719与实际a08构建同树；本节和[机器回执](../../research/2026-11-08-e2b-release-diagnostics-and-ci-wire.json)的officialInstanceBootstrapCorrection随同PR更新。下一head仍须自己的完整CI、实际Web/E2B、官方校验和与真实订阅adoption，再做同tuple六次≤5000ms。没有新增正式六次或性能PASS，#1505保持打开。

### 2026-11-08 11:07 UTC：实际 CI 收尾与 CUA 认证下载后继

ae838974/tree45acc 的实际 CI checkout 是 b73168f0（同树，parents main759+ae838）。截至11:05，10个workflow最新attempt均success；43个checks为35 success、7条件skip和1个macOS CUA非blocking failure，不能称所有checks全绿。主CI42472404087、四组PG、Node22、image、Apple Silicon真实打包/三进程Keychain/native及strict汇总均已成功。Cloud42472403980 attempt1两平台下载HTTP5xx仍保留；外部认领的一次失败jobs重试attempt2中，Linux128709991070完整下载、原SHA校验和真实driver成功，mac128709991144仍在下载阶段HTTP403/curl56，未进入原native测试。日志没有失败redirect hop，不能把403推定为限流或鉴权根因。

本次PG4实际保留53条完整数字socketTrace，其中29条detail记录；106个原始提及包括流式预览和收尾重复，不是106次测量。unlinked为9 SQL/932 B JSON/2639+6337=8976 B≤9326，revoked为7 SQL/781 B JSON/2285+5415=7700 B，均无新socket、未归属statement或截断。它们只证明本次原断言通过；旧9823/8547失败和未证实的因果继续保留，不改预算、不归功于pool或诊断调度。

有必要的后继仅改cloud-computer.yml两条CI下载：使用原contents:read的step级github.token，先转非export变量并unset继承环境；curl 7.83+运行时守卫、-q禁用curlrc、仅HTTPS起始和重定向、最多3次跳转，不使用location-trusted。Authorization仅留同origin，下载后清变量再执行原SHA/tar/vendor。固定asset ID、版本、校验和、Linux blocking/macOS nonblocking、真实driver及10分钟job上限不变。原retry2加retry-all-errors、connect20/max-time120、delay2和retry-max-time180；**180秒只是重试准入窗口，不是完整下载硬截止**。凭据转发边界依据[curl官方CVE修复说明](https://curl.se/docs/CVE-2022-27776.html)及[官方手册](https://curl.se/docs/manpage.html)。

本地固定358a7fcf/tree43cc的14项窄验证覆盖YAML/Bash、逆变换完整workflow相等、版本拒绝、子进程环境隔离和合成TLS的同源/跨host/跨port/降级/重试边界；独立peer无新增源码blocker。使用合成token，无真实GitHub资产请求、DB或worker rebuild；仍需新head的真实认证下载CI证明。root正常合并6a9892c9时仅重叠curl行冲突，按已审blob ea4a5825解决，完整结果tree与358a逐字相同。正式模板安装器不变，470项canonical输入不变，worker仍9da70595。

main759五条publisher及主CI均已终态；Desktop42470724706最后因匹配Web等待40分钟超时，macOS打包job跳过。Web只是Build失败且最后观察标记typecheck，终止子命令未知；不同受控私有构建的成功不冒充生产通过。#1505评论6720577633已明确释放11:00–11:30尾段，本节不预占后续共享窗口。本PR后继仍须自己的exact-head CI和fresh发布/消费者协调，实际Web/E2B、官方文件守恒、真实双订阅bootstrap adoption及同tuple六次≤5000ms均未完成，#1505保持打开。

完整失败原件、SHA和边界见[机器回执](../../research/2026-11-08-e2b-release-diagnostics-and-ci-wire.json)的authenticatedCuaCiFollowup；发布后的实际commit另回链到#1689，不能把本地提交当远端运行结果。

### 2026-11-08 11:43 UTC：完整 CI、生产环境对照与有限诊断修补

4d1a868a/tree472748 已完成自己的真实CI：实际checkout1e4d4ac4与PR同树、parents main759+4d1；10个workflow首轮成功，43checks为36 success/7条件skip、0 failure。Linux/macOS认证下载、原SHA和真实driver，四PG、Node22、Apple打包/Keychain/native、image及strict都通过。PG两项原预算仍8976≤9326和7700=7700，旧失败没有冲销。PR当时mergeable=true/clean只属于4d1，不能借给以下必要后继，更不能作为生产五秒结果。

生产排查已区分三种证据：c6ed/42473203908在隔离两库以production flags和真实overlay完成完整构建/254迁移；858/42474639858按正式Vercel文件与非空job优先规则，对实际两个DB只读检查连接、部分权限与history；e676/42475278958则用实际生产build-env和原wrapper，但显式MIGRATE0。最后一轮公开闭式回执为compilerWrapperExit=0、lastTypecheckCommand=frontend、typescriptCodes=[]、migrationSuppressed=true、deployed=false；producer没有单独报告pnpm child exit，不能补造该值，被mask的字节/hash/文本不复原。原owner另外报告原pending JSON表达式的纯SELECT成功，也不等于ALTER/trigger/真实迁移通过。受控检查没有复现旧759失败，原根因仍unknown。

正常合入公开554ad12e（parent ae838）的五文件有限诊断：固定root/API组合或frontend子命令分类，日志顺序前16个unique、格式受限4–5位TS编号后排序，以及migrate固定入口marker。编号并非官方注册表；marker在target解析及MIGRATE0早退之后、guard/SQL之前，既不证明SQL执行，也不覆盖更早的target解析异常。原build执行尾部3633 B逐字保留，guard/target/DDL/退出与私有日志规则不变；复用原作者24/24与两次独立源码peer，没有为此重跑DB。

随后真实TypeScript5.9.3语义错误和彩色formatter证明554会漏掉夹有ANSI的TS2322。7a4d4937仅对扫描行使用Node内建stripVTControlCharacters：旧函数实际RED（[]），同一新回归GREEN（TS2322）；原build-vercel单文件14/14及两个文件语法/lint通过。原Buffer、长度/SHA、枚举/16上限和执行尾部保持不变，测试还核彩色命令/marker与私有片段不外泄。这个诊断缺口不是旧759根因证明。

本地正常合流282497f5/tree4b43425b，470项canonical输入未改，worker仍9da70595；实际worker构建证据仍绑定a08，不冒称重建。上述后继同本节和[机器回执](../../research/2026-11-08-e2b-release-diagnostics-and-ci-wire.json)合批后必须完成自己的exact-head CI。#1503已实际启动42475556837/994、消费7e/0aef，至其C清理释放前保持main/生产publisher/共享账号稳定；分支源码与隔离CI继续。正式新APP/DPL/runtime/模板配对、官方文件守恒、真实双订阅采用及同tuple六次≤5000ms仍待实测，#1505保持打开。

### 2026-11-08 12:23 UTC：完整接入新的 main，保留已验证 worker

正式 #1505 验收仍未通过：旧六次完整 dispatch→ACK FAIL 原件不变，本段不是新的生产启动成绩。

- f94ee11c263aecd73f5f672e19d6809937107e65 自己的首轮 CI 已完整闭合：10/10 workflows success，43 checks=36 success+7 原条件 skip、0 fail。实际 checkout cc0c10c223641b8d94cdc6df75c16b129f5d72eb / tree5450578304ea611eaa846747da4935ebbb8560ba，parents=[759,f94]；root 复核全部47份原件、4,139,450 B，manifest SHA256 639ca379ac41e7fe70ceba61bcb4efa1a27ea83d9be648ed4aa9d85278ea26a0。PR离线E2B成功不替代真实订阅或发布。
- #1736 已实际正常合入 main c275637ed73966875610da7f831548d566868a62，treef2d35d2dcb4070cc86ea4900adabaf114d7b912e，parents=[75930406dda8708a84786475656ae449f5ffda88,7b50a4f5bed14c17a219151587c24c84d133f7f9]。本方完整接入此实际主线，未选择性摘取上游文件。
- 本地正常merge 27f5d780e1b13cd7fabe864a7677f00d8ae0b882 / tree1e3a92cb3b6b54ea358497cb8ca7d5c7e857d2dd 相对f94严格55文件。交叉历史造成4处文本冲突：3处 incoming 与main759逐blob相同，保留完整f94；package只接受上游 scripts.test:mobile，保留全部本方其他字段。独立临时索引把759→c275完整binary diff三方应用于f94，得到完全相同tree，未改root索引或用ours/theirs策略丢弃上游。
- 原模板/worker canonical内容未变，实际指纹仍9da70595d61ab946a6b4644f7cb1eaeec1bccc3d，实际构建证据继续绑定a08，不凭文档/上游移动重造一份构建结果。新组合仍须自己的CI；不能借f94旧绿灯发布。1561的独立两文件候选0f453未纳入本次整合。
- #1503同一GitHub child维护已有实际run42478565749/attempt1成功回执：fixture53a81ba92415a69b2ae59779f5dbd7580e7ee197a1d03391aa6f044617742786，token指纹968e6d51保持，本地expiry16:05:40.679Z、provider17:15:43Z。三次8项idle为0；这不替代模型订阅有效性或事后provider不存在证明。45分钟原正式入口检查针对新诊断scope，不能说成另一个child45分钟门槛。
- c275自己的Web/E2B/desktop/daemon/image/OTA及CI已实际启动；旧F后验provider清理及明确source/account释放仍未闭合。保留各来源真实结果，之后fresh核main、writer/consumer、完整新组合CI及实际窗口，再正常发布和正式CC×3/CX×3。

本次只追加真实主线整合与门槛状态；官方文件只增不删、原校验和、真实双订阅/sidecar采用、39 stages/14次实际版本检查/原完整公式与5000ms阈值均不变。公开进度见 [PR1689完整f94回执](https://github.com/alexj11324/Mikka/pull/1689#issuecomment-6721326928) 和 [同child维护回执](https://github.com/alexj11324/Mikka/issues/1503#issuecomment-6721380079)。

独立整合复核已闭合（manifest43401fffb3f3cee5eb25be202846cdeba9d0e67a2721283031b8926c8b18f612；固定27f验证9638eb77e5c7f735d30a0584dc5606e49f68a59259b1ba366933e9a3e977a018）：470个原始输入对象中469个逐字相同，唯一变动是package.json的test:mobile脚本；正式worker投影排除此脚本，因此指纹9da相同。这里不把原始blob相同与投影相同混为一谈，也不把静态整合证明称为新CI或运行时通过。

## 2026-11-09：官方 Codex 根证书的精确权限变化

官方空白对照 [42670291715/1](https://github.com/alexj11324/Mikka/actions/runs/42670291715)
在 `/usr/local/share/ca-certificates/e2b-ca.crt` 观察到 `file`、uid/gid 为 `0` 的
根证书从 `0644` 变为 `0777`。`before` 与 `pre_finalization` 的内容摘要为
`713ed37b92f312cf89345677c1d7f413c55b38ca0c1c636ce0fecc672d08ed9a`；
`ready` 的摘要不变，`fresh` 的摘要变为
`545244c4bc7f902ed9a6d843dd6ccaed08d0a59bbfc1b60064bd0278e026da5a`。
三个原始 JSON 成员及 ZIP/member 摘要见
[原件导出](../../operations/evidence/1505-official-path-control-20261109.json) 与
[范围说明](../../operations/evidence/1505-official-path-control-20261109.md)。
该证据和 Codex 定点策略来自 [PR #1835](https://github.com/alexj11324/Mikka/pull/1835)
固定提交 `cb2f771eeac0c8793e9f94b485dd87c7d5866b4c`，归档提交为
`45e0fccdb447dd0ae1943dafedfdb55adb4bf72b`。

仅 Codex 的这个精确路径新增 `_kind: file` 约束及 `0644 → 0777` 转换，
保留既有的 per-boot 内容摘要规则。原安装阶段仍严格拒绝改变，其他路径、
权限转换、所有者和文件类型不获例外；Claude 与 Desktop 的已有规则不变。
Node 发布回执校验补上与 Python 已有 `_kind` 约束一致的检查，防止把目录、
链接或缺失类型伪装成这条 regular-file 权限回执。Desktop APT 备份在对照四个
阶段均未变化，未新增任何 APT 例外。这个定点对照不代表本 PR 的候选验收、
真实订阅或生产发布通过。

### 2026-11-09：Codex 根证书权限的官方定点对照

在同一个 #1505 修复 PR 中继续保留“只许加、不许删或覆盖官方文件”的决定。
主线 `5ba1f9e2359ce714d83cd16fc040f2567c40a6d0` 的 R7
`42661874195/A1` 报告 Codex 根证书权限与 Desktop APT 备份摘要变化；
两者分别归因，不能将已证的 Claude 重链接行为扩展到其他路径。

新的 [官方定点对照 42670291715/A1](https://github.com/alexj11324/Mikka/actions/runs/42670291715)
仅从官方 codex/desktop 模板在 `/opt/mikka` 添加观察器，不安装 Mikka、
执行 CLI/模型、修改官方文件或 APT/timer，也不追加全盘扫描或等待。
Ops `b75871ea1753f75769daa33b095704475cf9a4a2` 的有序父为固定产品源
`5ba1f9e2359ce714d83cd16fc040f2567c40a6d0` 与已关闭载体
`b52445d24978dc46235b0744783eb7ebb3c3e397`，产品树仅增加三个普通文件。
完整原件、安全投影及边界见
[对照说明](../../operations/evidence/1505-official-path-control-20261109.md)
和[可重建 JSON](../../operations/evidence/1505-official-path-control-20261109.json)。

Codex `/usr/local/share/ca-certificates/e2b-ca.crt` 在 before/pre_finalization
均为普通文件、uid/gid=0、0644；ready 时变为0777而摘要仍相同，fresh
时保持0777、证书摘要随后变化。这提供了不含 Mikka 安装的正向证据，
仅支持 Codex 该普通文件的精确 `0644→0777` finalization 转换。
策略继续使用现有 matcher，保留原每次启动 CA 摘要语义、同一路径、
同一类型、未变所有者及 SHA256 格式校验，原有证书重链接目标校验不变；其他权限对、路径和类型
仍须拒绝。安装之后的 strict 检查与官方 CLI 原始摘要门槛不变。

Desktop 的 active/backup APT 节点在四阶段的摘要、大小、权限、所有者、
inode、device、mtime/ctime 全部相同，四个 APT unit 的已采属性也未变。
本次没有复现 Desktop 问题，因此不增加该路径例外。未采 cron 或写者
PID，不能从四个 unit 的静止状态证明所有后台写入均已排除。此前失败
仍保留；若正式构建再次出现该变化，须按当轮首次变化阶段定位写入者。
阴性对照和未激活的备用诊断不构成额外发布门槛，也不阻止完整 R7 通过后继续验收。

本对照未采 immutable 官方 base/build ID 或 envd 版本，私有输出 build
不能代替它们；控制的四个阶段名也不等于其他 R7 的失败阶段。两个私有
模板和两个实例均有 exact-ID 不存在的清理收据、errors=[]。入口正常
FF 关闭至 `376298951e4eee5970e2f0d00e21acb3ffba4e18`，关闭运行
`42670790551` SKIPPED。首轮 `42668993157` 的离线 guard 断言失败
及其 SDK/OIDC/观察全跳过事实一并保留；后来的成功不覆盖历史失败。

这些定点证据不替代三个官方模板的完整文件与 CLI 保全、两个真实订阅
CI 发布门槛，也不替代同一 APP/DPL/runtime/worker/template 元组下
Claude×3、Codex×3 的生产普通任务、工具与后续回复验收。#1505 仍须
六次完整 dispatch→agent 时间各不超过5000ms，目标2000–3000ms。

### 2026-11-09：发布端执行同一文件类型合同

构建端的 `official-files.py` 为每条 provider 变化无条件记录外层 `kind`，
并按策略 `_kind` 校验原节点类型；`before/after` 只包含发生变化的字段。
发布端 `assertConservation` 必须执行同一约束：策略声明 `_kind` 时，
外层 `change.kind` 必须精确相等，缺失、null 或错误类型均拒绝。当前
这两条声明仅为 Claude `/usr/local/share/e2b` 的 directory 与 Codex
根证书路径的 file。此校验不要求未变化的字段重复出现在差异中，合法的
mode-only、mode+SHA、SHA-only 回执继续使用原合同。

Codex 根证书的 `0644→0777` 已由上述官方对照支持，因此发布器旧测试
不再将它作为非法转换；负例改用未经许可的 `0644→0755`，并覆盖真实
对照的权限和摘要转换，以及类型缺失、错误权限、所有者和路径变化。
这次补齐消费端既有类型约束，不修改 Python matcher 或扩大策略允许集合，
也不替代 strict 安装前后摘要、官方 CLI、真实订阅和生产时延门槛。

### 2026-11-09：Codex 0.167.0 的匿名初始化版本拒绝

[R7 42690423873/A1 的订阅检查](https://github.com/alexj11324/Mikka/actions/runs/42690423873/job/129425290133)
绑定产品源 `7848e79df9c5af67e526aeed1c828858db392066`、worker
`aa7efbbe2969d8b1578bdba093e6400a26749e07`。Claude 的真实订阅及
bootstrap adoption 完整通过；Codex 的共享订阅执行、真实工具、工具后
回复及 runtime evidence 通过，但 `template_gate_bootstrap_adoption_missing`
使发布失败。Codex 的启动回执为1548.509ms，其中正常 `cli_init`
为88.531ms，准备回执为 unavailable/null；这不是完整 dispatch→agent
时间，也不能据此报告五秒验收通过。

该轮候选记录的官方 CLI 是 `0.167.0`，原始二进制摘要为
`e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af`。
失败原件 `subscription-diagnostics.json` 保持6384B，SHA256为
`ca8ad628f11addabacbadfe4c7475d4186b0dfc0ec52ba50860b559f4122541e`。
原件没有匿名 `initialize` 响应或拒绝原因，不能补造一条已观测的异常。
源码中的 `startAnonymousCodex.prepare()` 只接受 `0.166.0`，因此正常的
`0.167.0` user agent 会在发送 `initialized` 前被拒绝。候选随后关闭，
适配器走原冷启动路径，只有成功采用候选才公开的准备回执保持缺失。

版本扩展依据官方固定提交 `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`
（0.166.0）与 `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`
（0.167.0）的定点源码对照：
[user agent 生成](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/login/src/auth/default_client.rs)
仍使用官方包版本；`initialize` 的请求与响应合同不变，
[新增的 requiredHumanApproval](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-protocol/src/protocol/v1.rs)
为默认 false 的选择项。两版 `ThreadStartParams`、
[线程启动处理](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/thread_processor.rs)
的相关完整函数，以及配置合并实现逐字相同。

本修复只明确允许 `0.166.0` 和 `0.167.0` 的匿名初始化，其他版本继续
拒绝；不降级或覆盖官方 CLI。既有 hint profile 保持原 wire 标识，
无凭据的匿名握手、fresh claim 身份与环境比对、一次性采用、撤销及
一 Task 一 VM 边界不变，不给普通 Task 增加字段或轮询。
固定 `12458fe22e1217f644e8b28f82ab856211e73b72` 基线的合成 IPC
回归先证明旧保护恰好拒绝3个0.167.0正例，其余29例通过；修复后，
候选、hosted adapter 与配置保护三套60例全部通过、无跳过。它们使用
无生产凭据的非 root Linux/Node24.22.1，不执行真实模型，也不证明
0.167.0 的生产采用或整套上游功能兼容。

官方文件只增不删、原校验和、两条真实订阅及实际 bootstrap adoption
发布门槛保持原样。后继仍须自己的完整 CI 和正式发布，再以同一实际
APP/DPL/runtime/worker/template 元组完成 Claude×3、Codex×3 的普通
生产任务；六次完整 dispatch→agent 各不超过5000ms 后才关闭 #1505。
