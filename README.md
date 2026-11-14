## #2254 官方 Web/Nitro 未读验收

2026-11-14 22:29:28–22:30:05 UTC。公共 `3a25432617426d3bce326904d9b15c7869c6c9e8` × 官方私有 UI `d4e39617442955c36b6698897d548a74203f015b`，正式 `node apps/frontend/scripts/build.mjs`、`node apps/api/scripts/build.mjs` 与 `scripts/start-app.mjs`。原厂 Linux Chromium 153.0.8010.0 的 1440×900、390×844 各浅/深色均实际操作。隔离 PostgreSQL 17，两测试身份与独立 session；Member 对 Owner Run 拒绝，Owner 实际打开一条对话后两个独立读水位从 `[1,1]` 到 `[0,1]`，Bot 从2到1，刷新后数据库和侧栏读回一致。截图仅含合成数据。真实 Apple iPhone 和 Desktop 平台交互另行记录。用于此项加载的独立 Eve 服务通过原健康端点，此项未执行模型。生产 pending。
