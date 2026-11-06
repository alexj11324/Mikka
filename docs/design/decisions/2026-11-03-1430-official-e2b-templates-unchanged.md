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

worker 升级重新构建带唯一版本名的三个模板，不覆盖旧模板或别名；上一版有效配置
保存在 `MIKKA_CLOUD_RUNTIME_PREVIOUS`，旧模板继续保留以便回滚。三模板 ID、
worker SHA、source commit 与模型目录必须整组匹配；单次 upsert 后逐项回读，
部分写入或错配必须重新验证，且不能覆盖有效的 previous。模板发布和应用配置
更新沿用 GitHub Actions 与 Web deploy 的发布队列，保持来源版本校验。
构建部分失败、source 过期、等待应用失败或订阅失败时，最终清理步骤按本次
source/run/attempt 标记关闭全部探测实例，再按唯一名称和 ID 删除仍为私有的候选。
删除后回读确认不存在，清理失败使工作流失败并保留收据。已公开模板及 previous
不删除；失败后的重试需要重跑整条流水线以重新构建候选。

## 性能与成本

[#1505](https://github.com/alexj11324/Mikka/issues/1505) 的生产验收仍是派发到 agent
开始执行至少三次均不超过 5 秒，目标 2–3 秒；建机本身的时间不能代替端到端时间。
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
