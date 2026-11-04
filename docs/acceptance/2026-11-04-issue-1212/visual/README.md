# PR #1220：Factory 实时通知界面实屏

应用提交：`a4f64527970e124b9e4d597fd528baa3c6c34c78`  
应用 tree：`ff6a5d15300aa5112d0e4763aad54a89b5d15afd`  
捕获时间：2026-11-04 14:01:42–14:01:47 UTC

## 环境与边界

- 按 #1210 的 Docker 失败后切换规则，在独立 Vercel Sandbox（8 vCPU / 16 GiB）完成生产构建；Node 24.22.1、pnpm 10.34.3、PostgreSQL 17。
- 全新隔离数据库和不可变 TestAccountPool descriptor 绑定此应用提交。通过正常 owner 登录，`next start --hostname localhost --port 3000` 的版本接口实际返回该 SHA。
- 使用本地真实 PostgreSQL Factory fixture；详情接口实际返回 200 和授权的 `liveWorkspaceId`。未拦截 API、未调用模型、未使用生产数据。
- 截图脚本只捕获页面，不运行浏览器测试套件。Chrome 157.0.8103.38，Noto CJK 字体；使用与页面状态一致的浅色／深色媒体设置。
- 本组截图检查 Factory 列表与候选验收详情的布局。提交后通知、去重、断线、后台、跨 owner／workspace 和撤销会话行为由该提交的真实 PG、workerd 和 React 回归覆盖；截图不代替生产推送或一小时性能验收。
- 8 张原始 PNG 逐张检查：中英文标签可读；390px 详情独立显示；1440px 同时显示列表和详情；长内容自然换行；深浅色状态及重试控件可辨认。
- `auditEvidence` 检查 9 个文件通过。Fixture 账号完成后由 TestAccountPool 隔离保留；没有生产测试数据。

## 截图

| 语言 | 尺寸 | 浅色 | 深色 |
| --- | --- | --- | --- |
| 中文 | 1440 × 960 | [浅色](zh-factory-live-1440-light.png) | [深色](zh-factory-live-1440-dark.png) |
| 中文 | 390 × 844 | [浅色](zh-factory-live-390-light.png) | [深色](zh-factory-live-390-dark.png) |
| English | 1440 × 960 | [Light](en-factory-live-1440-light.png) | [Dark](en-factory-live-1440-dark.png) |
| English | 390 × 844 | [Light](en-factory-live-390-light.png) | [Dark](en-factory-live-390-dark.png) |

[Manifest](manifest.json) 记录每张图片的 SHA-256、尺寸、主题和可见文本。此证据分支在完整应用提交之上只增加本目录；图片不加入应用 PR 的补丁。
