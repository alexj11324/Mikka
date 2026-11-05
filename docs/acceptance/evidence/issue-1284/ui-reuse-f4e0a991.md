# PR #1345：视觉证据复用收据

## 结论与版本

原 9 张截图可复用于 **f4e0a99143ab924390e8fbd915455c4abc7e21cf** 的既有视觉范围。没有重新渲染或重拍；所有图片保留原始文件名和 SHA256。

- 原图源提交：`8608b63f522e6bbb8db8fc0caac7f606f17cf218`，tree `ff973ac99fea66a4d97a757c1475103363fb21c4`。
- 当前发布提交：`f4e0a99143ab924390e8fbd915455c4abc7e21cf`，tree `1fc7e470a4ce8fa6f8cbbb43951140306a7b2544`。
- 只读核验工作树：`/workspace/Mikka-1345-main122`，本地提交 `4a5fb6b52602bca4769ca7fd430a2f5275af245f`。工作树干净，与已发布提交的 tree 完全一致。
- 核验时间：2026-11-05 05:27:05 UTC。
- 原生产视觉夹具 build ID：`fxfe5Eos05LO05IyBFUCD` 与 `m3pSOwiX1xaJ1hJ3_E9MY`。

## 复用依据

8 个核心组件/定义文件与 `app/globals.css` 均与原截图源字节相同；JSON 收据逐项保存旧、新 SHA256。附加核对的 21 个渲染依赖、ThemeProvider、`pnpm-lock.yaml` 和 package 的 dependencies/devDependencies/peerDependencies/optionalDependencies/packageManager/engines 也相同。`components/ui`、`components/reui`、`components/motion` 目录的 Git tree ID 分别一致。这是源文件和依赖的比较，没有宣称两次构建生成的全部 CSS 或 bundle 字节相同。

两份 locale **整文件均已变化**。本次只将真实组件使用的以下子树或键视为复用依据，已在 `en` 和 `zh-CN` 各自做完整值比较及规范化 JSON SHA256 核对，全部一致：

- `Settings.agentProfiles`（包含动态可用性原因与选择 reason code 的完整子树）。
- `IssueThreads.executionIdentity`、`Shell.newTaskDialog`、`Computer.status`。
- `Common.close/cancel/retry`、`Shell.attach/attachUnsupported`、`Devices.thisMachine`、`Coordinator.unavailable`、`Settings.secrets.e2b`。
- `Settings.modelOrder.cloud/local`：NewTaskDialog 仅通过 `locationT(order.location)` 使用这两个键；该 namespace 中其他主干文案变化不被误称为全子树相同。

整文件差异来自 Coordinator API 余额、RunErrors、IssueThreads.errorDetails、模型顺序、订阅共享及模型刷新等主干新增或调整；准确路径清单见 JSON 收据。英文相关键也已核对，但保留的 9 张图本身是中文视觉证据。

## 九张原图

桌面视口为 **1363 × 936**。移动范围是桌面页面中的 **390 × 848 CSS px 内容 iframe**（含边框外宽 392），不是原生手机整屏截图。下表尺寸是实际图片像素。

| 原图文件 | 图片像素 | 检查点 | SHA256 |
|---|---:|---|---|
| issue1313-8608b63-list-light.jpg | 1363 × 936 | 列表浅色：内置默认、可运行、已停用、来源移除 | `b5ba873283ec17184938bdc533d31becd9c57df63e1c5b1e90276b7aeb69c636` |
| issue1313-8608b63-list-dark.jpg | 1363 × 936 | 列表深色：共享状态颜色、图标、文字 | `55d96496da21213b32819c4abc8c065a24164a2d7da2afb541812f7ce99256dd` |
| issue1313-8608b63-editor-desktop.jpg | 1363 × 936 | 桌面编辑：固定 Agent/模型/来源、角色、强度、私有指令、Skills | `0fc234b5493dff4d9f301ba48f128c1864bfc5e53c5d88fba34410b8849eddda` |
| issue1313-8608b63-editor-390.jpg | 1353 × 981 | 390px 编辑：单列字段与固定保存/取消栏 | `23ff1b1325f06d7c46458e1d12c197ddbf287428516be4795196c3f525696a9e` |
| issue1313-8608b63-editor-390-lower.jpg | 1353 × 981 | 390px 编辑滚动：私有指令、Skills 与保存/取消栏 | `f047ecce75f299ec0acb55ce9954a3076c4e7559df2c0ad1c694286a044af79b` |
| issue1313-8608b63-task-picker-390.jpg | 1353 × 981 | 390px 新任务：真实标题行与展开菜单；不可用项禁用 | `0778920161e224a53764e9c5dd5b513b6be798af296dd4a22928f643aa76ddb4` |
| issue1313-8608b63-task-selected-390.jpg | 1353 × 981 | 390px 新任务：显式选中前端实现；箭头与标题一起换行 | `5689f3684f8d1c0775f22fecdc4a24b5656561c6728cb1b90345118eb586930a` |
| issue1313-8608b63-run-legacy-reason.jpg | 1353 × 1066 | 旧 Run：v3 冻结数据、按任务能力选择；旧英文 reason 不显示 | `7487f2979a07da1d2361f4b03a8fd7088890608f0358b7c11e5da6a8cbebc1c2` |
| issue1313-8608b63-run-coded-reason.jpg | 1353 × 1098 | 新 Run：capability_fit 显示中文“能力最匹配这项工作” | `dcc53e99a17fbcf405df5a41c3f099ac1ebbd03553f201fcc60c5fe62732c008` |

全部文件实际位于 `/workspace/scratch/`；完整绝对路径和本次重新计算的哈希见 JSON 收据。九项实际字节 SHA256 均与原收据一致。

## UI 单测与类型检查的版本边界

历史 `19a7094c313a6f56c08e37fb1061c5e6c75799a1` 的目标 UI 单测 **43/43 通过，0 失败、0 跳过**。检查覆盖 Coordinator 重试/余额改模型、Bot model picker、执行身份展示/解析与聊天错误分类。

从 19a 到本次 tree，受测生产 UI、其余四个测试文件、loader、type config 与锁文件均相同。`retry-reply-button.test.tsx` 只移动了 `chatError`、`chatEnabled`、`modelPicks` 三个顶层声明；去掉这三行后全文相同，全部测试和原断言保留。该结果可以作为未变 UI 行为的历史证据，不标记为 f4e0 新跑的 43 项测试。

19a 的全项目 typecheck 只保留为历史。f4e0 已有新的 [Source checks](https://github.com/alexj11324/Mikka/actions/runs/41973672831/job/127067542266) 成功，日志确认重新执行 `next typegen`、`pnpm typecheck`、protocol/mobile typecheck 与 `lint:code`。

后续于 2026-11-05 05:30:16 UTC 核实：f4e0 的 18 项 checks 全部完成，**17 success + 1 expected OIDC skipped**；[主 CI](https://github.com/alexj11324/Mikka/actions/runs/41973672831) 于 05:29:26 UTC 成功结束，含四个 DB、Core、Integration、Source、Daemon、strict UI 与 production-build gate。Analytics SSR、custody、Browser gate 和外部 GitGuardian 均成功。当前 main/base 仍为 `122fd9054b5400569fd2518f55c52cec8f04d28a`；PR mergeable=true、mergeable_state=clean，GitHub merge candidate 为 `636616f90868accb9afaff03a9259b7769a63e73`。这仅记录当时状态，不表示已合并或生产验收。

## 范围限制

这些截图使用真实生产组件，但目录、可用性、Profile、运行证据与账号身份都是合成 props / mock。截图不证明真实账户授权、HTTP API、CC/Codex 执行或生产部署验收。当前收据证明相关视觉输入源未变，并诚实复用原图；不把旧图改称当前提交生成。

本次没有修改产品代码，没有启动新服务，没有浏览器操作，没有新账号或数据库操作。原图、原视觉复核与原收据继续保留。最新版本的 CI、真实 API 和生产 Owner 验收分别由其对应证据记录承担。

