# #1207：同候选检查重试 · 实屏审阅

## 版本与环境

- 应用分支：`fix/owner-candidate-retry-1166`
- 实际构建提交：`3ce3f6b8098834d13346712514e519cc6679e41b`
- 应用 tree：`fffe139a87292223d2724ce51e8e23d937aed8cf`
- 已正常合入 main：`2a0e398762d35a94ac673d04ce3683d9de1568d7`；保留 #1205/#1206。
- Docker Cloud Sandbox Large（8 vCPU / 16 GiB），Node 24.22.2、pnpm 10.34.3、PostgreSQL 17、Chrome 157.0.8103.38。
- `next build` 后以 `next start --hostname localhost --port 3000` 启动；访问 `http://localhost:3000/mikka`。
- 全新 loopback 隔离数据库 `mikka_1207_final_e2e`；TestAccountPool 按该提交引导，正常注册/登录并通过部署 attestation。没有生产数据库写入。
- 拍摄：2026-11-04 12:31:17–12:31:38 UTC。48 张原始 PNG 的 SHA-256 与 [manifest.json](./manifest.json) 一一核对一致。

这些截图来自真实 production build 的真实页面和隔离数据库。六种任务状态由明确标注的本地视觉 fixture 提供；未拦截或伪造 API 响应，也没有执行模型、提供商或生产验收。本页证明显示与入口行为，生产执行结果在部署后单独记录。

## 逐项走查

| 人的任务 | 修改前 | 当前实际观察 | 结论 / 严重度 |
| --- | --- | --- | --- |
| Owner 从任务找到失败候选 | review/verify 失败后被验收列表过滤 | 任务卡与线程验收页均保留，并显示正确阶段状态 | Found / 0 |
| Owner 对当前候选重审或重验 | 普通入口没有同候选重试 | failed 时分别显示「重新审阅」「重新验证」；窄屏也可见且可到达 | Found / 0 |
| Owner 跟踪排队和运行 | 条目可能消失 | 六种状态均保留；pending/running 不显示重试或验收按钮 | Found / 0 |
| 手机用户查看候选与检查结果 | 继承现有验收页布局 | 390px 中英文浅深色无横向溢出，按钮固定在可见底部 | Found / 0 |
| 英文用户读取环境 | 初次实屏发现 Environment 与图标相撞 | 标签宽度由 w-14 改为 w-20，重建后所有英文图中均分离 | Found / 0 |
| 遇到旧 revision、重复点击或未知结果 | 无普通检查重试路径 | 72 项现有绑定/SSR/DOM 回归覆盖 busy fence、完整 eventId 重放、失配禁用、未知 200 和刷新不重发 | 自动回归通过；这些网络故障没有伪装成截图事实 |
| Owner 验收、发布或恢复已完成执行 | 已有控制 | 现有回归验证优先级保留；检查失败不再冒充发布失败 | 回归通过 |
| 非 Owner 访问 Owner 任务 | 依靠原认证与归属校验 | 本 PR 不修改权限/认证代码；隔离 HTTP suite 的 Owner/peer 正例与跨账号拒绝通过 | 原边界保留 |

本次逐张查看全部 48 张截图。浅深色边界、状态色、中英文字体、候选标签间距和手机入口均可用。英文桌面窄侧栏在较长的 Verification 状态旁会省略通用 Threads 标题；状态与导航完整，不影响操作。没有剩余严重度 3/4 问题。

### 设计依据与范围

沿用当前主线既有任务卡、线程验收面板、候选区及标准 Button；依据 `docs/design/README.md` 的来源优先级。没有把旧/已退役 Figma frame 当作新的设计依据，也没有引入新的组件、词汇或交互规范。检查 R-40/R-42、当前状态色、浅深色边界及窄屏布局；其他 Bot 列表、浏览器、Artifact rail、电脑配置和设置项均不在此 UI 改动范围。

`docs/review-checklist.md` 所要求的本地实屏门禁现已补齐；Alex 在 #1210 正文及本次执行指令中已授权完成截图审阅后自主合并。

## 验证与限制

- `pnpm test:factory-acceptance-ui`：72 pass，0 fail，0 skip。
- `pnpm lint:ui`：通过；`git diff --check`：通过。
- 最终提交 `next build`：成功；生产服务器正常启动；TestAccountPool 原生认证与 Factory HTTP 读取返回 200。
- [准确 head CI](https://github.com/alexj11324/Mikka/actions/runs/41828557248)、[Analytics SSR](https://github.com/alexj11324/Mikka/actions/runs/41828557358)、[Browser gate](https://github.com/alexj11324/Mikka/actions/runs/41828557274)：适用检查全部成功，17 项中 16 success、1 按条件 OIDC skip。
- 已执行 `node scripts/assert-test-model.mjs deepseek-flash`，退出 0；本地视觉采集无付费模型调用。
- 全目录证据扫描：49 files，0 archives，known credentials/cookies 检查 passed。未导出 storage state、cookie、密码或 trace。
- 另一次完整本地 TestAccountPool HTTP suite 为 7/9：两个既有测试要求普通读取在会话撤销/过期后立刻 401，而当前主线 `fresh-session` 对普通读取保留 5 分钟 signed-cookie cache，实际 200。该差异已如实记录，未更改认证保护或测试断言来变绿；不是本 PR 所改代码，也不是 PR required check。
- 尚未把本地 fixture 当成 Codex/API 生产三阶段执行证明。必须在 squash 后确认 **Web deploy** 成功、正式 `/api/version.build` 等于合并 SHA，才继续原 Codex 390 与 API a9e472。

## 全部原始截图

每个状态按中文/英文、1440px/390px、浅色/深色排列；点击可查看原始尺寸。

### review / failed

#### 中文

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![zh review failed 1440 light](./zh-review-failed-1440-light.png) | ![zh review failed 1440 dark](./zh-review-failed-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![zh review failed 390 light](./zh-review-failed-390-light.png) | ![zh review failed 390 dark](./zh-review-failed-390-dark.png) |

#### English（英文）

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![en review failed 1440 light](./en-review-failed-1440-light.png) | ![en review failed 1440 dark](./en-review-failed-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![en review failed 390 light](./en-review-failed-390-light.png) | ![en review failed 390 dark](./en-review-failed-390-dark.png) |

### review / pending

#### 中文

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![zh review pending 1440 light](./zh-review-pending-1440-light.png) | ![zh review pending 1440 dark](./zh-review-pending-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![zh review pending 390 light](./zh-review-pending-390-light.png) | ![zh review pending 390 dark](./zh-review-pending-390-dark.png) |

#### English（英文）

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![en review pending 1440 light](./en-review-pending-1440-light.png) | ![en review pending 1440 dark](./en-review-pending-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![en review pending 390 light](./en-review-pending-390-light.png) | ![en review pending 390 dark](./en-review-pending-390-dark.png) |

### review / running

#### 中文

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![zh review running 1440 light](./zh-review-running-1440-light.png) | ![zh review running 1440 dark](./zh-review-running-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![zh review running 390 light](./zh-review-running-390-light.png) | ![zh review running 390 dark](./zh-review-running-390-dark.png) |

#### English（英文）

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![en review running 1440 light](./en-review-running-1440-light.png) | ![en review running 1440 dark](./en-review-running-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![en review running 390 light](./en-review-running-390-light.png) | ![en review running 390 dark](./en-review-running-390-dark.png) |

### verify / failed

#### 中文

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![zh verify failed 1440 light](./zh-verify-failed-1440-light.png) | ![zh verify failed 1440 dark](./zh-verify-failed-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![zh verify failed 390 light](./zh-verify-failed-390-light.png) | ![zh verify failed 390 dark](./zh-verify-failed-390-dark.png) |

#### English（英文）

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![en verify failed 1440 light](./en-verify-failed-1440-light.png) | ![en verify failed 1440 dark](./en-verify-failed-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![en verify failed 390 light](./en-verify-failed-390-light.png) | ![en verify failed 390 dark](./en-verify-failed-390-dark.png) |

### verify / pending

#### 中文

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![zh verify pending 1440 light](./zh-verify-pending-1440-light.png) | ![zh verify pending 1440 dark](./zh-verify-pending-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![zh verify pending 390 light](./zh-verify-pending-390-light.png) | ![zh verify pending 390 dark](./zh-verify-pending-390-dark.png) |

#### English（英文）

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![en verify pending 1440 light](./en-verify-pending-1440-light.png) | ![en verify pending 1440 dark](./en-verify-pending-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![en verify pending 390 light](./en-verify-pending-390-light.png) | ![en verify pending 390 dark](./en-verify-pending-390-dark.png) |

### verify / running

#### 中文

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![zh verify running 1440 light](./zh-verify-running-1440-light.png) | ![zh verify running 1440 dark](./zh-verify-running-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![zh verify running 390 light](./zh-verify-running-390-light.png) | ![zh verify running 390 dark](./zh-verify-running-390-dark.png) |

#### English（英文）

| 1440px 浅色 | 1440px 深色 |
| --- | --- |
| ![en verify running 1440 light](./en-verify-running-1440-light.png) | ![en verify running 1440 dark](./en-verify-running-1440-dark.png) |

| 390px 浅色 | 390px 深色 |
| --- | --- |
| ![en verify running 390 light](./en-verify-running-390-light.png) | ![en verify running 390 dark](./en-verify-running-390-dark.png) |
