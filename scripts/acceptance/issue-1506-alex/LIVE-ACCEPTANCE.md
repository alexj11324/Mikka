# 真实 live 传输与核心消费者验收

## 执行入口与范围

新增 `.github/workflows/issue-1506-alex-continue.yml` 仅监听自身 YAML 和 `control/continue.json`。它复用真实 ready receipt `receipts/fixtures-ready-42286389783.json`，不调用 workspace setup、model choice、share action 或 fixture create。控制文件目前 `enabled=false`、`expectedSha=null`，因此不会读取凭据或发起生产验收。执行者在候选版本实际部署后，把这两个字段改为 `true` 和精确生产 SHA。

支持的 phase 是 `cache`、`cache-live`、`tool`、`group-public`。两个模型顺序独立运行，某一项失败不会改成通过，另一个模型仍运行；每个模型阶段前后独立读取实际版本。`group-public` 只覆盖新群的公开停止路径，**不覆盖 private generation 分支**；私聊分支需要另外完成实际生成边界及服务端取消证据，当前入口不把它算作通过。

默认 `cache-live` 会运行已经授权的两条短缓存验收消息。live observer 不再增加模型消息：它复用这两轮正常消息产生的真实 `bot_chat` 推送。`cacheTurns` 可为 2 或 3，`liveTabs` 可为 2 或 3；默认三独立消费者。

## 实际加载的产品代码

工作流第二次 checkout 精确 PR #1522 head `7cd5a2c0836ee5ee1e0b91213e0a9fcee35c2032`，放在独立 `live-source/`。九个源码文件的 SHA256 已与该提交的 Git tree blob 逐项核对。运行前再按硬编码 hash 检查，任何变化都会拒绝执行该 harness。

Node 24 的 `stripTypeScriptTypes(..., {mode:'transform'})` 将七个纯 TypeScript 模块编译到临时目录；唯一文本转换是给相对 import 补 `.mjs` 后缀。实际加载的运行类是 `LiveChannel`、`TabShare`、`PersistentReadCache`，并使用原版 `coversLiveRevisions` / `heldRevision`。没有复制、删改、简化这些产品算法。`hooks/use-live-key.tsx` 和 Coordinator 组件用于 hash/protocol 核对，不在 Node 中渲染 React。

worker 的 refresh 接线遵守该 hook 的完整条件：

- 同一授权 namespace，且 cache 仍有效。
- 共享结果覆盖要求的 revision，也覆盖本地已经持有的 revision。
- 采用结果前检查本地 data identity 未变；本地发生写入时重新读。
- 保留 `requiredRevisions` 和 `reuseCompleted`，不把新推送变为无条件旧结果共享。
- 保留生产 Coordinator 的 `CHAT_MERGE_MS=2000`。

这里验收真实 gateway 传输和实际核心消费者。报告明确 `reactSWRRendered=false`、`browserReactRender=not_run`；不能把结果称为浏览器 React/SWR 页面实测。

## 三个独立 tab 的实现

每个 tab 是单独 Node worker，具有独立 heap、模块实例、缓存、`LiveChannel`、`TabShare` 和真实 WebSocket。跨 worker 通过原生 BroadcastChannel 仲裁共享读取。每个 worker 的环境是空对象，不接收 GitHub runner 的 ACME 密码或任何其他环境凭据。

正常 email 登录和 cookie 只保留在 parent 进程内存。worker 只可请求两个固定方法：该 Bot 的正常 `syncCoordinatorChat`，以及服务器授权初始 chat 指定的 transport scope 的 live ticket。代理不会接受任意 URL、action 或 Bot ID。ticket 只在两个进程的短期内存之间传递，不写文件或日志。

三个 tab 的 read namespace 完全相同，包含实际账号、当前专属 team、生产 build 和 admin role；各自 tab ID / heap 独立。transport scope 从正常 chat 的 `live.workspaceId` 取得，Coordinator 的 owner-home channel 可以不同于当前 team，不能猜测替代。parent 同时核验 initial chat 的 owner/Bot，以及每次实际 chat 响应的相同 owner/Bot/transport scope。

正常产品 `LiveChannel` 在 socket 打开时会执行 catch-up read。报告将这些请求标为 `initial`，只有所有 tab 的真实 ready 和初始读取结束后才允许缓存测试发送消息。`initial` 请求不能计入 revision 驱动的读取证据。

每个 tab 只取得一个票据并建立一次 socket。断线或重新申请 ticket 使验收失败，harness 不增加重连或 fallback 轮询。原类的 heartbeat / 合并调度属于实际被测逻辑；ready 能力确认后原类本身关闭 fallback read。最多 24 个实际 chat 读取，单次 RPC / ticket 有超时，最终覆盖等待有界。所有 observer 都结束后清理自己的 worker、socket、BroadcastChannel 和临时编译目录。

## 证据与旧结果竞态

产物 `coordinator-live-haiku.json` / `coordinator-live-luna.json` 包含脱敏网络计数、时间、revision、每个 tab 的 refresh/adopt/reject，以及原短回复缓存测试结果。没有 prompt、reply、聊天历史、cookie、完整 ticket 或协议凭据。

必须分别观察：真实 socket revision → 原消费者 refresh → 正常 chat HTTP/RPC → 响应覆盖目标 revision → 其他 tab 通过原版 TabShare 采用正确结果。共享读取指标需要真实采用结果和网络数量减少；仅看到多个 socket 推送或一次手动 GET 不合格。最终关闭前，所有 tab 必须持有已观察到的最高 revision，不能靠重复 GET 补齐。

默认不人为制造竞态。若自然运行中没有旧结果被新 revision 拒绝，报告 `staleResultProtection=not_covered`，不把代码测试当成生产覆盖。可显式设置 `delayOneReturnedResult=true`：只在 parent 中暂缓交付一个**已经从生产正常返回、完整读完**的 chat 响应，最长 8 秒，直到另一个真实更高 revision 到来再交付。它不阻塞生产请求、不伪造服务器事件、不修改产品消费者算法；报告记录这个客户端测试适配、旧结果 revision、交付原因与时间。若期限内没有新 revision，按时释放旧响应并标明竞态未覆盖。

这个适配只用于验证新 revision 不能被旧共享结果满足，不用于改善或计算模型首字时间。模型的 send→firstText 始终来自独立正常 NDJSON 流。

## 离线验证

五项 live harness 测试和两项 continuation guard 已通过。两项 live 测试真正启动三个独立 worker，加载上述同 hash 产品源码，使用原生 BroadcastChannel；只把 WebSocket 换为明确的离线事件夹具，网络 fetch 全部禁用。

- 一次 revision：三个 tab 最终同步，仅一个权威 chat 读取。
- 暂缓已返回的 revision 2 响应，真实形状的 revision 3 夹具进入后：旧结果被原算法拒绝，最终总共两个权威读取覆盖 revision 2 和 3。

这两项是离线 harness 证据，不是生产 live 成功的替代品。测试专用入口 `live-worker-offline.mjs` 仅由测试 WorkerClass 加载；生产始终启动 `live-worker.mjs` 和原生 WebSocket。

```bash
MIKKA_LIVE_SOURCE_ROOT=<精确候选代码 checkout> node --test \
  scripts/acceptance/issue-1506-alex/continuation.test.mjs \
  scripts/acceptance/issue-1506-alex/live-consumer.test.mjs
```

当前作者没有执行新增生产请求或模型调用。最终结论以正式 invocation 的产物、实际部署 SHA 和对应服务端日志为准。
