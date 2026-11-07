# 真实 live 传输与核心消费者验收

## 执行入口与范围

这是待最终部署完成后使用的源码与 workflow 切换稿，尚未上传或执行。`continue.json` 保持 disabled、生产 SHA 为空；presence after job 也显式禁用。当前生产上的 cache-only 诊断仍使用原 `7cd5a2c0836ee5ee1e0b91213e0a9fcee35c2032`，因此不能提前上传这份切换稿。未来 cache-live 继续复用 ready receipt `receipts/fixtures-ready-42286389783.json` 和已经保留的两个模型 fixture；各模型阶段前后核验实际版本，不重新创建工作区或选择模型。

默认 `cache-live` 会运行已经授权的两条短缓存验收消息。live observer 不再增加模型消息：它复用这两轮正常消息产生的真实 `bot_chat` 推送。`cacheTurns` 可为 2 或 3，`liveTabs` 可为 2 或 3；默认三独立消费者。

## 实际加载的产品代码

内容基准为本地 batch commit `aaecbdba0472af1a4ad921913267118741e74f1a`，包含 #1538 presence client 和 main #1501 的 Coordinator 组件。十个源码文件的 SHA256 逐一固定，新增 `lib/live/presence.ts`，更新 `channel.ts`、`hooks/use-live-key.tsx` 和 `coordinator-chat.tsx` 的哈希；其余六项保持原值。

发布用 `LIVE_SOURCE_COMMIT` 和未来 continuation workflow 的 source checkout 均固定为本次明确输入的 application source commit `efb95d951ddbeca1af04bc80d011ccbc2a9f0188`，tree 为 `fd7fb13f41c5a87df865f539d498b32e3a4fb83b`。十个文件已逐一核对该 Git commit 的实际 blob；本地内容基准 aaec 仅保留为审查来源。源码加载同时校验文件哈希和 checkout 的实际 Git HEAD，不能给另一提交的字节贴上新版本标签。本文件仅记录准备核验的源码；实际生产应用 SHA 仍是另一个验收输入，目前未赋值；最终部署确认、文件一致性确认后，才可填写并启用现有 control。

Node 24 的 `stripTypeScriptTypes(..., {mode:'transform'})` 将八个纯 TypeScript 模块编译到临时目录；唯一文本转换是给相对 import 补 `.mjs` 后缀。实际加载的运行类是 `LiveChannel`、`TabShare`、`PersistentReadCache`，并使用原版 `coversLiveRevisions` / `heldRevision`。没有复制、删改、简化这些产品算法。`hooks/use-live-key.tsx` 和 Coordinator 组件用于 hash/protocol 核对，不在 Node 中渲染 React。

当前 Coordinator 的聊天订阅没有 device presence proof，与 worker 的订阅参数一致。实际 `LiveChannel` 会请求 `presence=1` 并解析 presence readiness；本稿加载完整的新依赖，但聊天验收不覆盖设备 presence watch/ack 场景。#1501 组件使用的 `readCachedCoordinatorChat` 页面缓存恢复流程也不在此核心消费者验收范围内。

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

十一项 live harness 测试通过，包含 sourceBase 未设置/格式错误、checkout HEAD 不符、新 presence 模块和 hook/组件内容漂移，以及 pin 缺失时模型 driver/observer 不得启动。两项 live 测试真正启动三个独立 worker，加载上述同 hash 产品源码，使用原生 BroadcastChannel；只把 WebSocket 换为明确的离线事件夹具，网络 fetch 全部禁用。夹具同时核验新消费者请求 `revisions=1&presence=1`，并发送明确的离线 presence readiness 帧。

- 一次 revision：三个 tab 最终同步，仅一个权威 chat 读取。
- 暂缓已返回的 revision 2 响应，真实形状的 revision 3 夹具进入后：旧结果被原算法拒绝，最终总共两个权威读取覆盖 revision 2 和 3。

这两项是离线 harness 证据，不是生产 live 成功的替代品。测试专用入口 `live-worker-offline.mjs` 仅由测试 WorkerClass 加载；生产始终启动 `live-worker.mjs` 和原生 WebSocket。

```bash
MIKKA_LIVE_SOURCE_ROOT=<精确候选代码 checkout> \
MIKKA_LIVE_TEST_SOURCE_BASE=<该 checkout 的完整 40 位 SHA> node --test \
  scripts/acceptance/issue-1506-alex/continuation.test.mjs \
  scripts/acceptance/issue-1506-alex/live-consumer.test.mjs
```

当前作者没有执行新增生产请求或模型调用。最终结论以正式 invocation 的产物、实际部署 SHA 和对应服务端日志为准。
