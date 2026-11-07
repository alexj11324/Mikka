# #1512：a907 Native 原件、CI 与生产验收入口合并记录

本 checkpoint 保存 PR #1665 的实际 Native 原件、Source/Core 与 daemon/PG CI、安全认证/客户端审计、ce67 main 发布终态，以及 afae 合并来源核验。原始证据不因后续修正而改写。

## 结论

- 实际 CI/Native source：`052740cf37c4788853eb98df9d66ea7c646ea0c2`；tree：`f26ed2aef4dee31f8d7e17fba6a5d2ad74cb93d7`。
- PR head：`a9072e5835a1f7e14aae0af0033d1b682433651f`；正常 merge：`afae721f6730434ded6be932a7f9dd585c22ee49`。两者的实际 CI merge tree 与最终 main tree 精确相同，父提交为 ce67 与 a907。
- 9 个 PR workflows 全部成功。原 driver 26、helper 13、actor 30 与 Live 59 完整通过；daemon 1322 pass / 2 skip，4 组 PG 均成功。
- **Native 登录 210 / Chromium Web 188：仍失败，差 22。** Native 启动 179 / hosted Electron 199：仅本轮通过。功能作业成功不代表查询预算通过。
- Native 原件含 12 个 checkpoint、8 个分段、4 个总窗口；root 独立重算 17 operation 与 75 source，24 行全部守恒。没有移动窗口、重算历史缺失数据或把逻辑 RPC 个数当成 SQL 个数。
- 原件无逐次 RPC 调用时间；`otherScoped` 的 17 次净差仍未归到具体端点。认证已有请求内复用；没有为降低计数而弱化 PKCE、一次性票据消耗或撤销校验。
- ce67 Web 与 E2B 发布已结束；最新 runtime-refresh Vercel deployment READY，E2B 7/7 成功。正式模板 retained_public，临时 sandboxes=[]、errors=0。日志中被掩码破坏的版本 JSON 未被伪称为独立可读回执；按精确脚本版本与验证步骤成功记录。
- 新 main afae 的生产发布与浏览器任务尚待后续证据。**本 checkpoint 不证明生产 trace/AI/Logs/Replay 验收通过；#1512 保持 OPEN。**

## 文件与重现

`index.json` 逐文件记录 UTF-8 字节数、SHA-256 与 Git blob。Native 原始 21 文件保持原字节；新增 root reader 可在 Node 下读取 `evidence/desktop-a9072e/lifecycle.json`，核对累计计数差分、时间边界、分桶和全窗口总数。

Native 恢复环境 `sbx_xIvmBWvZ93L1hxcIiIDtITMXq7AJ` 已主动停止并读回 stopped。未归档原始账号、cookie、token、请求内容、DOM、截图或签名下载 URL。compiled manifest 核对源码身份，不宣称证明 Native 二进制逐字节身份。

较早的失败、取消和缺失原件保留于本证据分支既有提交历史。不要用本轮启动通过覆盖早先启动失败，也不要把旧 75 项 source 表按未来新增标签补零。
