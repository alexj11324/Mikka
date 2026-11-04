# 群聊 Factory 回复链接：本地验收证据

PR: #1252。产品提交 `afb60130270ab08a740a4fdcc4c1f0a885ed5fe1`，Git tree `a7e46d48e307706463766b8e4362467ab2367bbd`。

这组证据验证群聊 bot/agent 回复使用现有 Markdown renderer 后，Task、Thread、成果证据可以正常打开。它是本地真实 production build 的界面和点击验收，不是模型执行或生产 Factory 验收。

## 环境与真实入口

- 原 Large Docker Cloud Sandbox，Node 24.22.2、pnpm 10.34.3、PostgreSQL 17，独立 loopback `*_e2e` 数据库。
- 干净的固定产品提交；`pnpm build`（含类型检查和迁移）退出 0。描述符与 HTTP 版本都绑定上述提交。
- 正常 TestAccountPool 注册、登录和资源预留；通过正常 `POST /api/conversations` 创建群聊。仅显示用的 Bot 回复、任务及线程记录写入本地测试数据库。
- Owner 群聊读取返回 200，隔离 peer 返回 404；持久化 `group_turns` 数为 0，没有触发模型或 worker。
- 真实浏览器点击 Task 和 Thread，核对实际新页面的 issue/run ID、任务标题与线程内容；没有路由拦截或伪造页面响应。

## 最终截图

`manifest.json` 记录 2026-11-04 19:15:19.999–19:15:30.379 UTC 的实际捕获、每张截图的 SHA-256、视口和语言。

| 状态 | 中文 | English |
| --- | --- | --- |
| 桌面浅色，1440 × 960 | [截图](zh-group-1440-light.png) | [截图](en-group-1440-light.png) |
| 桌面深色，1440 × 960 | [截图](zh-group-1440-dark.png) | [截图](en-group-1440-dark.png) |
| 手机浅色，390 × 844 | [截图](zh-group-390-light.png) | [截图](en-group-390-light.png) |
| 手机深色，390 × 844 | [截图](zh-group-390-dark.png) | [截图](en-group-390-dark.png) |

[点击 Task 后的任务页](en-opened-task-1440-light.png)和[点击 Thread 后的会话面板](en-opened-thread-1440-light.png)在实际内容就绪后捕获。10 张最终图片均逐张目视检查；链接可识别，手机正常换行，落地页显示正确任务和会话。

## 验证与清理

- 原实现的真实组件回归先出现 2 个失败：三个 Markdown 引用没有生成 anchor。修复后 `pnpm test:groups` **24/24**，0 skip。
- `next typegen`、`pnpm typecheck`、`pnpm lint`、完整 production build 均退出 0。
- 固定产品提交的五个 GitHub Actions workflows 全部成功，CI run `41890417020`。
- 最终浏览器回执中 console errors 和 HTTP failures 均为 0。
- 10 张 PNG 的文件尺寸、SHA-256 和 manifest 逐一核对；`verification.json` 同时保存原始测试/构建日志的摘要，原日志保留在工作记录中。
- 19:15:30.457 UTC 已删除本次本地测试资源；受浏览器读取/视图状态影响的账号对保持 quarantined，不将它重新标为可用。
- 截图、manifest 经已知凭证/cookie 泄漏检查；没有公开密码、模型 key、平台 token 或连接串。

## 捕获修正历史

18:57 的首次本地点击断言通过，但两张落地页截图捕获得过早，仍有加载占位；文件名还错误地写成中文，而实际页面语言是 English。该批记录完整保留，[首次 manifest](history/initial-capture-manifest.json)也随本证据存档。

仅修正仓库外的捕获脚本：等待真实任务线程列表和内容就绪，使用页面实际 `html.lang` 生成元数据，再用新的 TestAccountPool 资源重做同一提交的截图。没有更改产品代码、断言、权限、验收期限或模型，也没有新增模型调用。

## 尚待生产验收

合并后仍需确认 Web deploy 成功、`/api/version.build` 等于合并提交，并在真实群聊原 Factory 回复上重新点击 Task/Thread。本文及这些本地显示夹具不替代该步骤；#1210、#1212 的其他未完成验收也不因这些图片而完成。
