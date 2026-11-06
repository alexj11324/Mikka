# ACME MCP：有限等待与客户端取消

本稿只准备了独立、默认禁用的验收入口，没有生产调用。它使用正常 ACME email session → owner-managed public client → PKCE S256 authorize/consent → opaque MCP bearer，再清理本次 token/client/session。不会创建 Bot、工作区、模型连接或任务，也不改变 active workspace。

## 固定范围

- 账号必须匹配 `OFtPbAHifGBAOYiek9hd3w`；不把 ACME 凭据映射到 smoke 环境变量。
- `MIKKA_ACCEPTANCE_SHA` 必须为明确 40 位 SHA，且调用开始／结束的真实版本接口都匹配。源码 driver 的 SHA、Actions run/attempt 单独记录。
- 只有固定 acceptance 分支上的这个精确 workflow 的 push 可以通过入口守卫。工作流目前 job 条件显式 `false`、应用 SHA 为空；上传本身也不会加载凭据。
- 唯一新 OAuth client 使用单次随机 intent。只申请 `mikka`、authorization_code、native/public/S256，不申请 `offline_access`、refresh、client secret 或管理权限。
- 当前服务端默认 access-token TTL 为 3600 秒。报告同时保留这个已核对的默认值与 token response 的真实 `expires_in`；缺失、无效或大于 3600 秒均拒绝。不是签发了几分钟的 server TTL；本次结束立即 revoke/delete 缩短实际使用期。
- 所有 cookie、client ID、intent、state、code、verifier、token 和历史正文仅在内存中，报告不会保存这些值。

## 最多三次 `tools/call`

| 阶段 | 唯一工具和参数 | 判定 |
| --- | --- | --- |
| latest | `read_coordinator_messages({limit:1,waitSeconds:0})` | 必须恰好一条真正最新可展示 row、`last` 等于其 position，且 `working=false`。否则 `not_covered`，不补读历史、不使用大 after、不停止已有工作 |
| bounded wait | `{after:上述last,limit:1,waitSeconds:90}` | transport timeout 110 秒。约 90 秒后空结果、同 cursor 且 idle 才记录有限等待观察。提前回复／工作或过早空结果不当作健康 idle 通过 |
| cancel own HTTP | 同一 90 秒请求 | 响应 headers 到达后，预定 5 秒时 abort 自己的 POST 并取消自己的 reader。提前正常返回标 `not_covered`。不发 Coordinator Stop、`notifications/cancelled` 或 MCP DELETE |

取消计时的边界名称是 `http_headers_only_server_readiness_unproven`。headers 已到不代表 PG subscription 已 ready；5 秒是明确的客户端采样点，不是工具或数据库边界证明。即使客户端及时 AbortError，`runtimeEvidence.serverCancelObserved` 和 `subscriberCloseObserved` 仍为 null，由 root 关联同 request ID 的产品 finally 日志确认。

MCP 此工具硬绑定 ACME 的个人 Coordinator，没有 Bot/workspace 参数。临时 client 不能隔离个人聊天。此 driver 不主动生成回复，`controlledPersonalReply=not_covered` 始终保留。真实受控 writer→通知→回复因果链由隔离 PG/产品测试另证，不能借用 team Bot fixture 冒充。

`read_coordinator_messages` 的正常入口可能执行既有 ensure/backfill 维护；本 driver 的 `explicitBusinessWrites=0` 不等于数据库绝对没有写。报告明确 `backendMaintenanceWritesMeasured=false`。

## 正常 OAuth 与清理

1. 先核对输入和实际应用版本，再读取 runner 中既有 ACME secret，正常 email 登录并核对 owner。
2. 正常 `get-clients` 记住 baseline ID 集合；一次 `create-client`，再 `get-client` 核对 owner、唯一 intent 和所有注册字段。
3. 复用正常 PKCE helper。OAuth authorize 仅使用严格同源的 `redirect:manual`；正常 consent 返回的 loopback URL 只解析和校验，不向 loopback 发请求。报告 `browserConsentUI=false`。
4. 注册结果丢失或返回 5xx，不重复创建；只用一次 `get-clients` 按唯一 intent + baseline 差集对账。多个匹配或 owner 不符则保留 unresolved，绝不删除未证明归属的 client。
5. 无论业务失败还是自然活动未覆盖，均尝试正常 revoke 本次 token、用原 bearer 做一次 MCP `tools/list` 验证 401、删除精确自有 client并确认404、核对原 client ID 集合、登出并确认本次 session 不存在。撤销失败不阻断独立的 client 删除与登出。

`tools/list` 只出现在 revoke 后的拒绝验证，不属于三个业务 `tools/call`。所有 token cleanup 都由普通 OAuth endpoint 执行，未使用 DB 或 admin 旁路。client ID 不写入公开或本地 cleanup 文件，响应不确定而无法完成清理会在结果中明确标 `unresolvedResources=true`。

业务阶段有 240 秒总期限；清理请求各有 20 秒上限，不共用已耗尽的业务期限。workflow 的 12 分钟上限为正常 setup、业务期限和最坏情况下的清理留出空间，避免业务超时直接截断 finally。

## 复用来源与依赖

`pkce-session.mjs` 是 main `1a70bb79d7dc4ab31418e9fa674dd39c0a1cae01` 的 `tests/support/mcp-closeout-session.mjs` 逐字节副本。cookie jar 函数逐字复用同版 `scripts/acceptance/read-cache-production.mjs`；managed ownership、intent reconciliation、revoke/delete/signout 流程来自同版 `scripts/acceptance/mcp-production.mjs`。

acceptance 497 基准尚无这组 main probe 的完整依赖，因此采用两个自包含、仅 Node 内置模块的 runtime 文件。没有削弱旧 issue1415 的 smoke/attestation 守卫，也没有更改其 helper。旧 helper 的 initialize 仍是 30 秒上限；三个 reader 请求使用新 driver 自己的明确 timeout，不忽略旧 signal。无需 pnpm install。

## 离线检查

```sh
node --test scripts/acceptance/issue-1212-mcp/mcp-reply-production.test.mjs
```

测试替换全部 fetch 并显式禁止默认 global fetch；真实随机 PKCE verifier/S256/state 验证仍通过被复用的 helper 执行。所有 OAuth/session/响应均为合成夹具，90 秒只在夹具的 clock 中推进，不代表生产等待结果。测试涵盖：输入/版本在凭据前拒绝，exact owner，完整三调用与清理，游标/active 状态，早回结果，客户端 abort（含 transport 不响应 abort 的本地边界），注册确认不明，foreign/ambiguous client，state/refresh/TTL 错误，revoke/delete/version 失败，以及分片 UTF-8/SSE、matching ID、size/protocol 拒绝和报告脱敏。

## 结果与未来激活

`status=observed` 仅表示客户端有限等待、取消观察与清理都完成。`acceptancePassed=false` 始终保留，root 必须用产品 finally 的固定数字/枚举日志补足是否 ready、期间是否存在周期查询、是否接到 abort 和是否关闭订阅。未采样或未取得运行日志时不能把这些字段改为 true。`not_covered` 退出码 2，业务/清理失败退出码 1；都保留脱敏报告。

生产 SHA 目前为空，workflow job 仍 false。最终产品发布和两库迁移核对后，root 才在一个明确激活 commit 中填写实际 SHA、移除 `false &&`，保留 repository/event/ref 条件、现有精确 OIDC selectors 和唯一 `production-smoke-owner-acceptance` 锁。观察只运行一次，不因未覆盖或失败自动重试；先保留实际证据并完成清理。
