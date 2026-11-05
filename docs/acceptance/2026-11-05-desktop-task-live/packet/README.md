# DesktopIntegration：既有任务列表推送消费端

## 可审范围与身份

本候选只迁移 DesktopIntegration 的任务列表读取，尚未创建 PR、合并或部署。Related tracking issue: #1212。

- 基线：`5d2011f0f27a4ae300909dd1632ffede8a763471`，tree `66e43629a684bfed778cadd1df3c073d93cddb5a`。
- 候选实际 Git tree：`6050481953e91c6b32c2f03a48d62e9cdf3a3760`，当前仅存在于隔离 Vercel 工作树。
- 分支：`feat/1212-desktop-task-live-20261105`。
- 三个 own files：`components/desktop/desktop-integration.tsx`、`scripts/desktop-task-list.live.test.tsx`、`package.json`。
- `source/` 是三文件完整源码；`filemap.json` 可用于精确 GitHub tree 创建；`evidence/candidate.patch` 是实际 `git diff --cached`。
- `evidence/candidate-metadata.json` 列出了三文件字节数、SHA-256、Git blob，以及 11 个依赖在 efef / 当前 main / 候选之间的相等证明。全部已在共享导出后重新逐一验证。

该分支最初建于 efef；随后正常 fast-forward 至 5d2011，完整保留其四个 cloud-computer question refresh 文件。迁移依赖的 11 个模块在这次主线推进中均未变。

## 行为变化

DesktopIntegration 只在实际 desktop runtime 挂载内部无界面 consumer，按 `userId` 建立独立生命周期。consumer 直接使用已经在主线的 `useLiveTaskRunList(userId)`，与看板共享 Owner 任务列表的 SWR key 和 canonical home 推送通道，不再自行每 15 秒调用 `listTaskRuns`。公共 hook、通知生产者、WebSocket、Worker、DO 与服务器读取授权均未修改。

Owner 改变会重新建立通知 baseline；已有 waiting/failed/finished 行只更新 badge，不重放旧通知。Decision 返回时检查原 consumer 生命周期，防止旧 Owner、退出 desktop 或卸载后的异步结果产生原生通知。待处理 native notification click 及旧 click listener 也有相同的卸载隔离。

原 `desktopRunUpdate`、通知文案/链接、badge 规则、Settings 的 shared `preferences` key、`pushAllowed` gate、正常 Decision 服务端 session/owned-run/current-status 检查、Decision 模型选择，以及设备自动安装逻辑均保留。`package.json` 只向现有 `test:live-lists` 命令追加本文件，使用现有 CI gate。

## 实际验证

所有命令在既有 Vercel Sandbox 的独立工作树执行；Node 24.22.1、pnpm 10.34.3。没有模型调用、生产请求、生产任务、生产配置变更、新资源或数据库变更。

| 门禁 | 实际结果 | 原件 |
| --- | --- | --- |
| 最终 fixture 对原 5d 产品 RED | 真实等待 16,101.7 ms；task reads 1 → 2；准确在禁用旧 15 秒周期读取断言失败 | `red-final.log`、`red-final.hashes` |
| 同一最终 fixture 对候选 GREEN | 真实等待 16,102.3 ms；初始 reads 2 → 2；canonical home ticket；18 个 Desktop case 通过 | `green-final.log`、`green-final.hashes` |
| 原有 live list + 新 Desktop combined gate | 31 / 31 通过，0 fail、0 skip；18 Desktop + 13 原有列表 | `green-final.log` |
| Next typegen / 全应用 typecheck | 最终 exit 0 | `typegen.log`、`typecheck-final.log`、`static-final.exits` |
| 两个 TS/TSX 文件 oxlint | 0 errors、0 warnings | `lint-final.log` |
| 原导航策略检查 | exit 0 | `navigation-policy.log` |

最终 RED 与 GREEN 使用同一个 fixture，SHA-256 为 `302d16cff49f75bbd885fccf011284d607233bcd93f1b277e437cd76bf58d03b`。初次 16 项 GREEN、初次 RED、以及 typecheck 中两处测试数组被空数组断言收窄为 `never` 的失败也全部保留；仅把该两处断言改为等价 `length === 0`，没有放松产品 gate。

18 项 Desktop 组件回归实际运行 React、SWR、LiveProvider、LiveChannels、真实列表 hook 和通知规则。mock 仅限服务端 actions、ticket/WebSocket、平台探测和原生 bridge；Decision 边界是受控异步返回，不运行模型。覆盖 web 零读取/零 ticket、共享去重、正确 home、初始 baseline、Owner 切换、迟到 HTTP、迟到 cookie Owner 变化、旧 Decision/点击回调、原偏好开关、Decision 拒绝/失败、hidden/foreground、断线重连、无写自然到期。

### 原始警告

combined 日志保留 Node module-mock 实验/弃用提示和两处 `TimeoutNaNWarning`，不声称全日志无警告。额外一次 hidden case trace（exit 0）定位到现有 SWR 把 `setTimeout.bind(undefined, revalidateAllKeys...)` 直接注册为 visibility listener；HappyDOM 传入的 Event 成为 Node timer 的 delay 参数，数值转换得到 NaN。实际 vendor 片段与版本/hash 在 `swr-focus-callback.json`，完整栈在 `hidden-warning-trace.log`。没有隐藏警告或修改共同 transport/计时规则。

## 范围限制与后续门禁

1. 这是读取/通知消费端的组件验证，不是原生 Electron 客户端、真实账号/真实 Worker 的生产验收，不包含一小时前后观测。生产效果、CI、issue 正文的发布/测量门禁仍由 root 独立处理；当前不合并。
2. 现有全局 `preferences` key 没有 Owner attestation；本 PR 按已确认范围保留 shared Settings 合同，不声称修复共享偏好缓存的跨 Owner 归属问题。测试证明本 consumer 的 Owner baseline/任务响应与迟到回调隔离，以及给定当前偏好时的原门禁。没有改动服务端 Decision 或借改 key 绕开 Settings 更新。
3. 读取失联、后台、重连和自然期限全部沿用现有 live hook/通道契约；未实现 A 的 daemon/native 授权 source，未取消其它面板的轮询。
4. 组件仍返回 null，没有新增页面 DOM、布局、文案、主题或 native notification 样式；展示规则模块的 Git blob `e32edc7af48d37c5e67febb70f1aa2e8494d3976` 未变。故没有新造截图；本次可见行为由实际通知参数/badge/导航回归证明，后续真实客户端验收不能用这些 fixture 代替。

## 原件包

- `desktop-live-evidence.tar.gz`：21 个原件 + 原始 evidence manifest，SHA-256 `61d6a989f7d8baa1be14a0639f0128d70a0fae7bea7197505d35055342e94d72`。
- `desktop-live-warning-trace.tar.gz`：3 个追加诊断原件，SHA-256 `35f2b364b8ad7b9cb0bbe0ed673a96a65baef60f8e38e5c6db3f3ec9ef8b3e1a`。
- `packet-manifest.json`：共享 packet 的最终逐文件 hash（不包含该 manifest 本身）。

没有本任务创建的数据库或角色；测试进程均已完成，未停止共享 PG 或 Sandbox。
