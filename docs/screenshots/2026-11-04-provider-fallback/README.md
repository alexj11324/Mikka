# #1225 模型失败接续：界面审阅页

> 本文保留当次版本的三路模型证据与失败。现行验收使用共享 SMOKE 账号，
> 官方 Claude Code 与 Codex 两条订阅路径独立记录。DeepSeek/API-key 路径
> 已退出合并及验收门槛，后续执行按 [验收指南](../../acceptance.md)。

关联 [issue #1225](https://github.com/alexj11324/Mikka/issues/1225) / [PR #1232](https://github.com/alexj11324/Mikka/pull/1232)。本页汇总全部 32 张截图，不另建导航、弹窗或模型选择入口。

## 版本与证据边界

- 分支：`fix/1225-model-provider-fallback`。
- 实际构建：`079d74d575c03633380fd0ffb111812ae1b12180`；2026-11-04 UTC。
- Docker Cloud Sandbox Large：8 vCPU / 16 GiB，Node 24.22.2、pnpm 10.34.3、隔离 PostgreSQL 17。
- 截图来自 `pnpm build` 后的 `next start`，访问 `http://localhost:3128/mikka`；正常测试账户租约登录，仅导航和截图，无浏览器功能测试。
- 四种状态使用隔离数据库中的固定测试数据。截图证明界面显示，不代表调用了真实模型或完成生产验收。画面中的 Claude → Codex 是显示样例；生产验收另测真实 `deepseek-flash` 402 → 订阅接续。
- 源码在采集前后指纹一致：`992087a414e2746e08034c6fcb1e4d4c9568f00e0c764f8d70c58be8895e266a`。
- 所有测试数据已清理，工作区自动名称和账户指纹恢复，租约正常释放；凭证审计通过，浏览器诊断和横向溢出均为 0。账户菜单已遮挡。
- [verification.json](verification.json) 保存每张图片的尺寸、SHA-256 及以上结果，不包含登录材料。

## 用户任务走查

布局依据 `docs/design/README.md` 的优先级，沿用 `main` 上的线程、输入区与模型不可用卡片。本次没有正在审阅的独立 Figma 草稿或新增页面，不将旧 Figma 画面当作更高优先级来源。

| 用户任务 | 之前 | 现在 / 找到的位置 | 结果 / 严重度 |
| --- | --- | --- | --- |
| 任务遇到服务商失败后继续 | 原来源重复失败，消耗修复预算 | 接续完成后，线程回复旁显示原模型、失败原因和目标模型；输入区显示当前目标 | Found（可找到），0 |
| 确认手动指定的模型没有被替换 | 沿用显式选择 | 同一线程明确显示“指定模型不可用，未切换”，保留指定模型和处理入口 | Found（可找到），0 |
| 所有可用项耗尽后恢复 | 重试用完后停住 | 逐项原因 → 模型设置 → 既有重试与输入区，均在当前线程内 | Found（可找到），0 |
| 等待宿主接续结果 | 原失败信息可能与后继结果混杂 | pending 状态不伪造切换成功，也不提前显示全部不可用卡片；保留输入区 | Found（可找到），0 |
| 在手机上处理同样的问题 | 复用线程布局 | 390 px 下原因自动换行，模型设置、重试与输入区不互相遮挡 | Found（可找到），0 |
| owner / member / 首次使用者处理自己的任务 | 既有账户与工作区权限 | 复用同一受鉴权线程和设置入口；没有增加仅管理员可用的恢复控件 | Found（可找到），0；权限另由数据库/API 测试验证 |

逐图复核覆盖中文 16 张、英文 16 张。R-10 标准输入区、R-40 无新增赘述、R-42 双语、R-74 模型品牌标记均核对；明暗主题、窄屏、所有新增状态通过。既有重试、设置、权限与停止机制保留；本次不声称通过截图验证键盘交互或后台行为。

## 同版本检查

- 最终定向回归：105 个测试通过，0 失败；包括模型切换视图、真实旧会话恢复、数据库 fallback、设置鉴权和验收驱动。
- 类型检查、oxlint、UI/交互规范检查通过；生产构建成功。
- 真实 HTTP 预检：6 个实际导出的页面 action 可发现，完整 workspace Bot 活动与自己的线程可读，空闲检查成功，不存在的 Artifact 返回 null；正常租约释放。
- [代码提交的 CI](https://github.com/alexj11324/Mikka/actions/runs/41874987843) 通过，10 个关联工作流于 17:17:49 UTC 全部成功。截图文档提交的最新 CI 仍作为合并门槛。
- 本地 API/CLI 真实 `deepseek-flash` 调用返回 402，Coordinator 阶段余额不足阻止了任务创建；该路径记为 blocked，不记为功能验收成功。合并后的三条独立生产路径及真实接续结果另回写 issue。

## 截图

`pending`：等待宿主接续回执；`switched`：已切到 Codex 并显示结果；`blocked`：所有候选不可用；`picked`：显式指定模型失败，保持原选择。
### 中文 · 桌面 1440 × 1000

| 状态 | 明亮 | 深色 |
| --- | --- | --- |
| pending | ![中文 pending 明亮 1440](zh-CN-pending-light-1440.png) | ![中文 pending 深色 1440](zh-CN-pending-dark-1440.png) |
| switched | ![中文 switched 明亮 1440](zh-CN-switched-light-1440.png) | ![中文 switched 深色 1440](zh-CN-switched-dark-1440.png) |
| blocked | ![中文 blocked 明亮 1440](zh-CN-blocked-light-1440.png) | ![中文 blocked 深色 1440](zh-CN-blocked-dark-1440.png) |
| picked | ![中文 picked 明亮 1440](zh-CN-picked-light-1440.png) | ![中文 picked 深色 1440](zh-CN-picked-dark-1440.png) |

### 中文 · 手机 390 × 844

| 状态 | 明亮 | 深色 |
| --- | --- | --- |
| pending | ![中文 pending 明亮 390](zh-CN-pending-light-390.png) | ![中文 pending 深色 390](zh-CN-pending-dark-390.png) |
| switched | ![中文 switched 明亮 390](zh-CN-switched-light-390.png) | ![中文 switched 深色 390](zh-CN-switched-dark-390.png) |
| blocked | ![中文 blocked 明亮 390](zh-CN-blocked-light-390.png) | ![中文 blocked 深色 390](zh-CN-blocked-dark-390.png) |
| picked | ![中文 picked 明亮 390](zh-CN-picked-light-390.png) | ![中文 picked 深色 390](zh-CN-picked-dark-390.png) |

### English / 英文 · 桌面 1440 × 1000

| 状态 | 明亮 | 深色 |
| --- | --- | --- |
| pending | ![English / 英文 pending 明亮 1440](en-pending-light-1440.png) | ![English / 英文 pending 深色 1440](en-pending-dark-1440.png) |
| switched | ![English / 英文 switched 明亮 1440](en-switched-light-1440.png) | ![English / 英文 switched 深色 1440](en-switched-dark-1440.png) |
| blocked | ![English / 英文 blocked 明亮 1440](en-blocked-light-1440.png) | ![English / 英文 blocked 深色 1440](en-blocked-dark-1440.png) |
| picked | ![English / 英文 picked 明亮 1440](en-picked-light-1440.png) | ![English / 英文 picked 深色 1440](en-picked-dark-1440.png) |

### English / 英文 · 手机 390 × 844

| 状态 | 明亮 | 深色 |
| --- | --- | --- |
| pending | ![English / 英文 pending 明亮 390](en-pending-light-390.png) | ![English / 英文 pending 深色 390](en-pending-dark-390.png) |
| switched | ![English / 英文 switched 明亮 390](en-switched-light-390.png) | ![English / 英文 switched 深色 390](en-switched-dark-390.png) |
| blocked | ![English / 英文 blocked 明亮 390](en-blocked-light-390.png) | ![English / 英文 blocked 深色 390](en-blocked-dark-390.png) |
| picked | ![English / 英文 picked 明亮 390](en-picked-light-390.png) | ![English / 英文 picked 深色 390](en-picked-dark-390.png) |
