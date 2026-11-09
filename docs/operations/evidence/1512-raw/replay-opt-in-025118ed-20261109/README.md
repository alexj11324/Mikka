# #1512 — 官方 Replay 自动化配置修复与当前 CI（Checkpoint 21）

**生产 ACME 验收仍为 0；#1512 保持开放。** 本 checkpoint 记录新的源码与正式 Node 验证，完整 CI、当前原生窗口和生产验收尚未完成。元数据观察时点为 2026-11-09 06:41:11 UTC；后续结果另追加，不改写这里的历史状态。

## 当前源码和保全

PR #1799 当前 head 为 `025118ed953ab80803ac3ba9548c3a309c5c69b4`，tree 为 `6da320a6f476624ba2e61ca7a1f5c704a3fdae25`。通过普通合并依次纳入 main88 和 #1790 的实际 main927，没有 rebase、force、直接写 main 或发布中间 ref。

最终递归树有 6,729 个 blob。相对 main927 的 33 个本方路径以外，6,696 个 main blob 的内容与 mode 全部保留；两个 daemon fake 的 100755 mode 保留。两份 generated 文件保留 repos、runs、claim 三处真实源 hash，243 routes / 315 methods。Source checks 已在实际 checkout 上执行 canonical generator --check 并通过。完整来源、父提交、9 文件指纹与原子 ref lease 在 source-publication.safe.json。

## 已查明并修复的 Replay 阻碍

固定版本 posthog-js@1.438.13 的默认 bot filter 会在 before_send 之前拒绝标准 headless actor；Replay snapshot 使用同一 capture 路径。这是对当前源码的确定性推导，未冒充已执行的生产失败，也不推断所有历史空 Replay 都由它造成。

验收 actor 在新建、限时、自己负责关闭的 browser context 中，先于页面脚本安装非枚举的内存 deadline marker。仅官方 origin、顶层 /mikka 文档、有效期限可启用官方 opt_out_useragent_filter。普通用户默认不变，UA/WebDriver 不变，遮罩、同意状态和项目设置不变。隐私过滤器只保留 SDK 的闭集 bot/browser 分类，普通事件和 snapshot 均适用。

deadline 限制的是 SDK 初始化资格，不是运行中的自动复位计时器。关闭本方 context 结束实例。自然同 session snapshot 仍须在唯一付费提交前发生；没有伪造 snapshot 或放宽 readiness。

包含作者的 8 文件精确 patch/manifest、根代理补充 tracing 文档以及独立的 9 文件审查。原作者 V8 验证和独立审查保留各自尚未跑 CI 的历史边界；后附新的正式 CI 回执。

## 本轮正式验证

CI [42573554116](https://github.com/alexj11324/Mikka/actions/runs/42573554116) 实际 checkout 是 `0b2b8a5296fa9ccda2a7f9921c26c2ff9b93ba02`，父提交 main927 + head025，tree 与 head025 完全相同。selection 真实选择 full=true、57 Core、29 Integration、72 DB suites。

Source、Core、Integration、Daemon、四个 PG shard、desktop checks/icon/smoke、Analytics SSR 均已成功。当前源码的 Node 日志实际记录了 21 条相关已通过用例，包括普通/验收 bootstrap、marker 期限与 accessor 拒绝、顶层官方页面注入、安装失败清理、闭集 browser 分类、自然 snapshot、未就绪/异常/超时/中止不得提交。它们证明源码行为，不能代替实际生产 SDK 摄取、Replay 渲染或真实模型调用。

image 与 Apple Silicon packaged acceptance 在捕获时仍运行。这里不提前宣布完整 CI 或 Native 预算通过。CP20 的 396≤414、181≤199 仅属于先前 1fa/f886 的原始窗口，不移用于本轮。

## PostHog 与生产准备的更正

实际 Notebook short ID 是 C9vQAc1L，读取版本为 15；timeline node UUID 是 notebook 单元 ID，不能当 saved insight numeric ID 交给 PNG exporter。当前尚无新生产 trace 的 saved insight。后续必须先得到实际 trace、创建真实保存的原生查询表，再用返回的 numeric ID 导出并核看 PNG 像素。

production-preparation-source-update.safe.json 将已有正式 GHA 配方绑定到新候选源码：核心 driver、workflow、export/replay helpers 与 benchmark 的 blob 保持一致；browser actor、两份说明按实际新 blob 更新。README 中 chosen=false 的旧阻碍描述已经修正为真实的 preferenceState=absent 临时选择及 revision-checked restore-implicit。没有 dispatch、ACME 登录、模型调用或提前占用生产窗口。

## 原件、隐私与边界

本包保留 selection/source/Core 等原始 UTF-8 日志（包括 BOM/ANSI）。Analytics SSR 公共副本精确替换 10 次 PostHog public capture key，明确以 redacted 命名；原始字节长度和 SHA256 单列，不称为原件。没有上传凭据、cookie、SAS URL 或生产 prompt/output。

四个 PG 的五份日志及详细执行、隐私回执已收入 ci-025118/pg：72 个选中脚本与 72 个唯一完成脚本完全相等，741+794+1635+617=3,787 tests 全部 pass，0 fail/skip/cancel/todo。根代理另对 72 行执行台账重算并与正式 selection 双向对账。四个临时容器与各自网络全部移除。C 16+11+5=32、A+B enrollment 13、unit fence 的 11→6 round trips 等实际明细保留；最新 Native/UIstrict 原件仍由职责读取者收口。aggregate job 129018515769 曾被根代理误按名字重复读取一次，实际全队读取 2 次；不把它的“Production build and browser interactions”名称当成真实浏览器或生产构建证明。

本 checkpoint 不关闭 issue，不声明生产版本已发布，不复用旧模型案例，不重试已由用户中止的 PostHog 登录。前序 checkpoint、失败、清理限制和账单 unknown 全部保留。
