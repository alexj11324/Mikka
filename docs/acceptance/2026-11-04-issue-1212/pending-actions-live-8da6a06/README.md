# Pending actions live — exact 8da6a06 evidence

## 精确版本与状态

- PR: [#1283](https://github.com/alexj11324/Mikka/pull/1283)，单独替换 legacy PendingActions 的 10 秒读取。
- 应用提交：`8da6a069de809b29f097c5eaf018fdeaa7032694`。
- 应用 Git tree：`4a7b4fec12a4c962b868527e9ad0c3865ce31b3f`。
- parent：#1269 的 `61545e2cfc9cd90e445a442c2762cb5ccfe6b4f1`。
- 独立源码复核的 17 个 code/test 文件 tree 为 `7f48489dbe8433d5c1bda0fb6be78951b616ad9b`；最终应用仅在此基础增加验收说明，代码相同。
- 此目录位于独立 evidence branch。它不修改应用 head，没有合并或部署生产。

## 已完成的本地和 CI 验证

在授权的 Vercel Sandbox 中运行 Node 24.22.1、pnpm 10.34.3、PostgreSQL 17.11；数据库仅 loopback。真实 Git 三方集成保留主线变更，当前 worktree 的 protocol 链接已核对。

| 检查 | 结果 | 原始证据 |
| --- | --- | --- |
| pending cache | 4/4 | [unit log](logs/pending-615-integrated-unit.log) |
| 实际 React/SWR + GET 接线 | 7/7 | 同上 |
| approved-write 兼容 | 96/96 | [approved log](logs/pending-615-integrated-approved.log) |
| 完整 live PostgreSQL | 35/35，0 skip | [live DB log](logs/pending-615-integrated-live-db.log) |
| 原 unattended PostgreSQL | 13/13，0 skip | [unattended DB log](logs/pending-615-integrated-unattended-db.log) |
| Device gateway | 全部成功，含 9 个实际 workerd case | [gateway log](logs/pending-615-integrated-gateway.log) |
| typecheck / lint | exit 0 / exit 0 | [types](logs/pending-615-integrated-type.log)、[lint](logs/pending-615-integrated-lint.log) |
| 完整 production build + 正常 TestPool 实屏 | exit 0，24 PNG | [runtime log](logs/mikka-pending-8da6a06-ui-runtime.log)、[launcher](logs/pending-8da6a06-visual-launcher.log) |
| 公开应用 SHA 的 CI | 8 个 workflow 全 success；27 jobs = 22 success + 5 expected skip，无运行中/失败 | [完整 job 清单](ci-jobs.json) |

回归实际覆盖外层 COMMIT、ROLLBACK、Drizzle nested savepoint、后续 SQL 失败、延迟 scheduler、默认库与请求库同 UUID 不同 owner、另一 owner 不接收、慢响应保守期限后的同 expiry 最终补读、旧响应 viewer 拒绝。route unit 的 mocked session 只证明接线，不作为新的真实鉴权撤销证明。

## 实屏复现与视觉检查

从本提交进行真实 production build，使用正常 TestAccountPool signup/sign-in、真实本地 HTTP 和 PostgreSQL。完整 bootstrap/build/start 均使用 `http://localhost:3352`；公开版本端点在截图前核准精确提交。

- environmentId：`local-e6ff84ef-9074-45d9-a34f-3ca400720a4a`。
- 采集时间：2026-11-04 22:44:05.127–22:44:24.813 UTC。
- 24 张原始 PNG：三种卡片 × 中英文 × 1440×960 / 390×844 × 浅色/深色。
- 每种卡片均通过正常 GET 读到 exact owned row，HTTP 200，viewer 与 observedAt 元数据验证正确。
- 0 console errors，0 本地 HTTP failures。每张图片 SHA-256、精确时间、fixture 类型和清理状态见 [manifest](screenshots/manifest.json)。
- 作者及独立代理分别逐一查看六张原像素拼版，覆盖全部 24 张。未发现叠字、裁切、按钮遮挡；窄屏 App JSON 正常换行。详情见 [独立视觉复核](independent-visual-review.md)。
- [独立源码复核](independent-source-review.md) 保留原始复核对象、数据库 caller 契约和未执行项目，不将源码阅读计作测试执行。

### 截图索引

| 卡片 | 中文桌面浅 / 深 | 中文手机浅 / 深 | 英文桌面浅 / 深 | 英文手机浅 / 深 |
| --- | --- | --- | --- | --- |
| Email | [浅](screenshots/zh-email-1440-light.png) / [深](screenshots/zh-email-1440-dark.png) | [浅](screenshots/zh-email-390-light.png) / [深](screenshots/zh-email-390-dark.png) | [浅](screenshots/en-email-1440-light.png) / [深](screenshots/en-email-1440-dark.png) | [浅](screenshots/en-email-390-light.png) / [深](screenshots/en-email-390-dark.png) |
| App | [浅](screenshots/zh-app-1440-light.png) / [深](screenshots/zh-app-1440-dark.png) | [浅](screenshots/zh-app-390-light.png) / [深](screenshots/zh-app-390-dark.png) | [浅](screenshots/en-app-1440-light.png) / [深](screenshots/en-app-1440-dark.png) | [浅](screenshots/en-app-390-light.png) / [深](screenshots/en-app-390-dark.png) |
| Browser | [浅](screenshots/zh-browser-1440-light.png) / [深](screenshots/zh-browser-1440-dark.png) | [浅](screenshots/zh-browser-390-light.png) / [深](screenshots/zh-browser-390-dark.png) | [浅](screenshots/en-browser-1440-light.png) / [深](screenshots/en-browser-1440-dark.png) | [浅](screenshots/en-browser-390-light.png) / [深](screenshots/en-browser-390-dark.png) |

### 明确的夹具和验收界限

App 卡片通过真实 `proposeAppToolCall` 创建；Email 和 Browser 是明确标注的隔离数据库显示夹具，Browser 不是已授权可执行的真实浏览器操作。显示正文故意含中英文，不代表界面文案漏译。

截图没有点击任何审批、发送或执行按钮，没有 decision POST、模型调用或外部 provider effect。没有请求拦截、browser test runner、生产流量或健康 WebSocket 验收。真实写入通知由独立 PG/React/workerd 门禁验证；这些截图本身仅证明真实构建和页面呈现。

TestPool 尚无 pending_actions resource adapter，因此驱动记录精确本地 fixture IDs，以 owner 条件删除自建消息和提案，再 quarantine 自用测试账号。manifest 记录清理完成。已检查截图/日志/驱动中凭证与 cookie 泄漏，未保存环境变量值或登录 cookie。

## 保留失败与可复现性

- 旧共同实现的 early-expiry 真实 RED 由父 PR 的独立证据保留，没有删除或改写。
- 新 Vercel 的最初空库缺 workspace schema 造成一项环境失败；[原始失败](logs/pending-observation-live-db.log) 与 exit 1 保留。使用仓库正常完整 migrations 初始化后，[同断言通过](logs/pending-observation-live-db-migrated.log)，没有放宽断言或修改产品来绕过。
- 本次下载 archive 为 1,070,413 bytes，SHA-256 `759eaa3841e0abc1f3fde71aabbbd99f3a3b302f08c6bdb068996474176af3b7`。24 个 PNG 的本地/公共 Git blob 已逐个核对。此目录包含展开后的原始文件，不依赖 archive 才能审阅。
- 复现驱动：[launcher](drivers/visual-launcher-final.mjs)、[runtime](drivers/visual-runtime-final.mjs)、[capture](drivers/visual-capture-final.mjs)。驱动需要独立 loopback 测试库及仓库正常 TestPool bootstrap；临时密码仅在运行时 env 中传递，不能放进日志或仓库。

## 尚未完成

PR 仍为 stacked draft。尚未完成 issue 正文要求的完整小时验收、父 PR 上线、匹配新 kind 的既有 Worker 发布、GitHub Web deploy 与生产公开 build pin、真实生产审批通知/前后台/断线验收。这里没有将本地测试、截图、正常空闲或历史指标计作生产通过，也没有关闭 issue。
