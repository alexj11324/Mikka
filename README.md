# #2254 未读侧栏 · 发布前浏览器验证

公共版本 85dfc39692d653c33ef9a4cb653263a55e667f96，官方私有 UI 版本 ddd75ba1f1c6dd467e17adecc82c3d1193a92e06。公共构建入口生成正式 Web，renderer SHA-256 为 8b1522e3f75dc40f126116ae79e441d724866d6c820ed7fb4438cc8502ce7c06。

2026-11-14 17:21:30–17:22:06 UTC，Chromium 153 和隔离的 PostgreSQL 17.11 上，Owner 与 Member 各用独立 Better Auth 会话。每个视口及主题都先通过真实 API 清零，再把两次已完成的合成运行分别标为未读。Bot 计数为 2，两条子项各为 1。实际点开第一项后收到了 read HTTP 200，数据库存有该项 runReadAt，另一项保留手工未读。回到收件箱后重载，Bot 计数为 1，只有第二项仍有标记。Member 对相同运行标未读收到 404。四张图均为重载得到的结果。具体时间和每张图的 SHA-256 见 receipt.json。

浏览器连接本机正式 Web 产物，API 由项目原始应用 handler 处理，HTTP 适配、测试身份和数据库之间均为真实读写。本轮标准 Nitro 编译在生成工作流后被本机终止，正式 Nitro 启动、桌面原生和 iOS 真机仍待验。生产发布与验收由 Mikka#1954 负责。
