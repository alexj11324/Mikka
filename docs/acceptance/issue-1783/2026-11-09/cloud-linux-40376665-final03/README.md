# Factory 可视证据硬门禁：固定版本云 Linux 验收

关联 #1783 / PR #1789。

## 版本与结果

- 代码提交：`40376665ac416ce2228c08b60d7ea8cee97a3de6`；分支：`HEAD`。
- UTC：2026-11-09T15:36:02.164Z — 2026-11-09T15:40:06.415Z。
- 环境：Vercel Sandbox cloud Linux；Node v24.22.1；pnpm 10.34.3；ffmpeg version 8.0.1-3ubuntu2 Copyright (c) 2000-2025 the FFmpeg developers。
- PostgreSQL 实际连接身份：`mikka_e2e|127.0.0.1|17.11 (Ubuntu 17.11-1.pgdg26.04+2)`，仅 loopback 隔离测试库。
- 测试：311/311 通过，0 失败，0 跳过；harness 退出码 0。
- 录像：真实 Xvfb/xterm 画面，经 FFmpeg x11grab 捕获运行中的命令与输出；未回放旧日志。处理不提供动作裁剪窗口，保留整个执行时间轴。

| 分段 | 结果 | 实测数量 | 录像时长 | 证据 |
| --- | --- | --- | --- | --- |
| 01-postgresql-gates | 通过 | 202/202; skipped 0 | 83.2 秒 | [录像](01-postgresql-gates.mp4) · [输出](01-postgresql-gates.txt) |
| 02-real-http | 通过 | 8/8; skipped 0 | 41.7 秒 | [录像](02-real-http.mp4) · [输出](02-real-http.txt) |
| 03-cli-daemon-ffmpeg | 通过 | 91/91; skipped 0 + 10/10; skipped 0 | 22.1 秒 | [录像](03-cli-daemon-ffmpeg.mp4) · [输出](03-cli-daemon-ffmpeg.txt) |
| 04-activity-registration | 通过 |  | 54.9 秒 | [录像](04-activity-registration.mp4) · [输出](04-activity-registration.txt) |

## 验收范围

PostgreSQL 完整定向套件覆盖缺证据阻塞、有效媒体与当前候选归属、直接审批/合并入口、公开 PR 证据回执、completion 等待 ready/failed、任务 activity 的录像与版本化报告关系。

真实 Vite/Nitro HTTP 套件启动本地应用，通过既有账号池完成正常登录并创建 PAT，读取 activity、原视频、字节范围、历史封面与报告；覆盖匿名、错误 owner/workspace、任务范围及撤销边界。HTTP 输出中的诊断 JSON 记录实际 origin 与隔离数据库名。

CLI 分段实际启动 Mikka MCP stdio 程序并调用 submit_capture，同时运行真实 daemon 上传/终态及取消回归。它证明 MCP CLI 与本地 daemon 路径；模型提供商与 GitHub 外部边界使用合成夹具。此报告不声称生产模型、OAuth 或 GitHub App 已通过。

FFmpeg 专项以合成 20 秒 MP4 和合法 free atom 构造超过 100 MB 的可解码源文件，实际执行压缩、ffprobe 及完整输入/输出解码，并校验首尾动作与映射时间点。详见 [readback.json](ffmpeg-readback/readback.json)、[处理后视频](ffmpeg-readback/processed.mp4)。大尺寸原输入保留在验收 VM 工作目录，按脚本可再生成；不并入 Git。

## 可视审阅

[截图与录像页](index.html)。前三段录像及结果截图的公开文件由实际 authenticated activity GET 返回的字节写入；写入前与已上传产物逐项比对 SHA，确保未改变证据。起始和中间关键帧来自该同字节录像。第四段是额外的操作见证，不属于 activity capture。12 张起始、执行中、结果截图已逐张直接查看；关键 SHA、测试数量和 PASS 结果清楚，未发现私有凭据。长命令或测试名可能超出终端边缘，完整内容见各段日志与 JSON。[逐帧审阅回执](visual-review.json)。测试及演示数据均为明确的合成夹具。

## 复现

使用与回执一致的代码和既有私有测试环境：

```sh
source /vercel/validation/test-env.sh
node /vercel/validation/issue-1783-harness/run.mjs 40376665ac416ce2228c08b60d7ea8cee97a3de6 <new-attempt-label>
```

环境文件不属于归档，禁止输出其内容。harness 每次创建新目录，不覆盖失败或历史证据。所有源命令及退出码保存在各分段 JSON，GitHub CI 关联及生产发布/任务验收由 #1783 的后续记录提供。

## 固定产品工具链与两条实际处理路径

产品 finalizer 使用 `ffmpeg-static-b6.1.1-linux-x64-e7e7fb30477f-4f231a1960d8`（实际版本 `7.0.2-static`）；终端录制器的系统 FFmpeg 版本单独记录在环境回执。两者没有混为同一个版本。

清空 PATH 后，daemon 直接函数及复制到独立目录的单文件 computer helper 均处理了 100004592 bytes 的真实可解码 MP4。输出 3780 bytes / 5533 ms；移除已知空闲 14500 ms，步骤映射为 1500 / 5000 ms。首帧像素 [254,0,0]，末帧像素 [0,0,255]；输入与两份输出完整解码成功。两条路径输出 SHA-256 一致：`2b00d582dbcce67936cb465a913a9249a245072a1058fe0de66bd8a020c62ccb`。

固定工具由上游同一发布的资产 ID、压缩 SHA 和解压 SHA 约束，只安装到 /opt/mikka 的版本目录；本轮录制重新执行这些处理，不复用开发阶段的运行结果。详见 [FFmpeg 读回](ffmpeg-readback/readback.json) 与 [独立 helper 输出](ffmpeg-readback/copied-helper.mp4)。

## 本次产物注册与同源 GET 回读

- 独立任务图：明确的合成传输夹具；task `bbbc1fe2-2945-4be1-ae3d-d6747b752fd4`，run `e41c6f27-d045-46fa-bb10-a60b43cc3661`，代码 `40376665ac416ce2228c08b60d7ea8cee97a3de6`。录像中的真实命令先执行，再创建这个独立图来验证产物传输和归属；不把该图描述为真实模型任务。
- 实际应用：`http://127.0.0.1:33979`。该临时应用与数据库验收结束即清理，归档中的 URL 用于证明当时同源关系，不作为长期可用链接。
- 前三段真实录像及其结果截图共 6 项，走正常设备授权、注册以及 capture begin / PUT / complete。第四段实际录制注册和回读操作，作为审计录像留在静态归档中，避免自注册形成循环。
- 报告：现有 `syncFactoryPresentation` 生成 immutable acceptance Artifact，实际 HTTP MCP `submit_artifact` 提交详细报告两个版本及独立截图索引文档（3 张图片内联引用、3 条对应录像链接、固定 SHA 和时点）。activity 返回同 run 的 image / video / acceptance / document；逐项 GET 校验持久化 SHA，所有下载的图片和录像完整解码，录像还校验 Range 206。
- GET 结果、方法、路径、状态和 SHA：[proof.json](activity-readback/proof.json)。接口原始安全投影：[activity.json](activity-readback/activity.json)。
- 15 项运行断言通过；注册回读退出码 0。清理：leasedAccountsReleased=completed；ownedApplicationStopped=completed；applicationPoolClosed=completed；workspacePoolClosed=completed；fixturePoolClosed=completed；ownDisposableDatabaseDropped=completed；adminPoolClosed=completed；ownPrivateAccountStateRemoved=completed；privateWorkingDirectoryRemoved=completed。

| activity 媒体 | 同源 GET 路径 | 状态 / 解码 | SHA-256 | 归档 |
| --- | --- | --- | --- | --- |
| 01-postgresql-gates.mp4 | `/mikka/api/factory/tasks/bbbc1fe2-2945-4be1-ae3d-d6747b752fd4/media/7e9268d2-1fbd-465b-95f0-a0129debb4bf` | 200 / decode 0 / Range 206 | `73adfd61b515213863cc0480e6914d21b6f8acffa0ac27f3d3aeacd14be4d381` | [实际 GET 字节](01-postgresql-gates.mp4) |
| 01-postgresql-gates-result.png | `/mikka/api/factory/tasks/bbbc1fe2-2945-4be1-ae3d-d6747b752fd4/media/79999697-3c00-4eda-b32e-16dbe2ad4d39` | 200 / decode 0 | `f288566d9489a6f6f12db49931b17d5460e6d56a14f02fa7555d8de6d248e92a` | [实际 GET 字节](01-postgresql-gates-result.png) |
| 02-real-http.mp4 | `/mikka/api/factory/tasks/bbbc1fe2-2945-4be1-ae3d-d6747b752fd4/media/334c00c3-4e57-476c-9f01-ba1f115cf0a5` | 200 / decode 0 / Range 206 | `0ca7f46aa54e67d9ff607bb9b85012f80e15fdd7fb50c4d35578eb5ee96f3981` | [实际 GET 字节](02-real-http.mp4) |
| 02-real-http-result.png | `/mikka/api/factory/tasks/bbbc1fe2-2945-4be1-ae3d-d6747b752fd4/media/22a7624d-8e77-4e32-8bc2-bf6ef25cd254` | 200 / decode 0 | `dc9fcd573e9188e2e224e5597335c4a1fd2aee5087d1b6ce702177267d2a15de` | [实际 GET 字节](02-real-http-result.png) |
| 03-cli-daemon-ffmpeg.mp4 | `/mikka/api/factory/tasks/bbbc1fe2-2945-4be1-ae3d-d6747b752fd4/media/50cb6a85-b271-4159-88df-573e24ed2db8` | 200 / decode 0 / Range 206 | `5327fb73cd3baa29e72ef798632702ba57523858009488aa856146f7029b48e7` | [实际 GET 字节](03-cli-daemon-ffmpeg.mp4) |
| 03-cli-daemon-ffmpeg-result.png | `/mikka/api/factory/tasks/bbbc1fe2-2945-4be1-ae3d-d6747b752fd4/media/efae00c4-b773-4255-93f3-0c8a3f97d38d` | 200 / decode 0 | `7b3092db7b2547186df3828f2bc6946a1e6e696eafa7712297dcd69a16bdee6a` | [实际 GET 字节](03-cli-daemon-ffmpeg-result.png) |

| API 读回文档 | 版本 | 同源 GET 路径 / 状态 | SHA-256 | 静态下载 |
| --- | --- | --- | --- | --- |
| detailed-report | 1 | `/mikka/api/artifacts/94681b89-7533-4500-bdf7-ac2248c7e397/versions/1/download` / 200 | `fd12fb427fd6ce15f396be206980fe17f48da7620f37e2c1fa759473f7b3eb47` | [document-94681b89-7533-4500-bdf7-ac2248c7e397-v1.md](activity-readback/document-94681b89-7533-4500-bdf7-ac2248c7e397-v1.md) |
| detailed-report | 2 | `/mikka/api/artifacts/94681b89-7533-4500-bdf7-ac2248c7e397/versions/2/download` / 200 | `54cf01ed24884ced67f4a7801e5dd734f7ed10b493ef302c658b9a0a20f92def` | [document-94681b89-7533-4500-bdf7-ac2248c7e397-v2.md](activity-readback/document-94681b89-7533-4500-bdf7-ac2248c7e397-v2.md) |
| screenshot-index | 1 | `/mikka/api/artifacts/3542371b-6215-4e20-b935-11d50e1986be/versions/1/download` / 200 | `dbeb0194fc3492899abd736b8ae30be59fb61e55b3cb7ff63a9fafb65ed47d4f` | [document-3542371b-6215-4e20-b935-11d50e1986be-v1.md](activity-readback/document-3542371b-6215-4e20-b935-11d50e1986be-v1.md) |
| acceptance | 1 | `/mikka/api/artifacts/63443314-2612-4d9e-85e9-89cc340fbd7d/versions/1/download` / 200 | `0f0976f79808f3b014b18a1fec8f165f806ecdc8186c22f1ba4d5dce899990a3` | [acceptance-63443314-2612-4d9e-85e9-89cc340fbd7d-v1.md](activity-readback/acceptance-63443314-2612-4d9e-85e9-89cc340fbd7d-v1.md) |
