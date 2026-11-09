# 当前会话的 Enterprise 退出目标

接口属于 #1608 Enterprise v1 后端；页面与原生客户端沿用现有 OIDC/SAML 退出流程。本增量没有新增数据库字段、会话权限或 provider 枚举接口。接口可用性以实际部署版本为准；新增 HTTP/PG 回归尚待公开提交的 CI 执行，不计入此前 66 项通过记录。

## 读取契约

用户点击退出时，以当前真实 Cookie 或原生 session bearer 请求一次：

```http
GET /api/enterprise/logout-target
```

不接受 query 参数、Workspace、Organization 或 provider 选择。成功响应始终为 `200`，带 `Cache-Control: private, no-store`：

```json
{"target":{"providerId":"enterprise-example","protocol":"oidc"}}
```

`protocol` 只能是 `oidc` 或 `saml`。只有当前未过期 human session 与有效 identity、同 Organization/provider 精确绑定时才返回目标。协议来自该 provider 既有互斥配置；配置变更清除旧会话的 assurance，存在 identity 时不能切换协议。返回体不包含 Organization ID、identity ID、session ID、端点 URL、密钥、token 或原始断言。

有效普通会话、已清除或失效的 SSO 绑定、撤销的目录/provider、归档的 Organization，以及失效的 SAML 根会话均返回：

```json
{"target":null}
```

匿名、无效/过期/已删除的 session、PAT（包括同时携带有效 Cookie 的 PAT）返回现有 `403 governance_denied/access_denied`。已认证请求若附 query 参数，返回 `400 governance_denied/invalid_request`。显式 bearer 保持现有优先级，不回退到另一份 Cookie 身份。

这是退出路径的只读投影，不是访问授权，也不表示通过 SSO 重登一定能恢复权限。不要用选中的 Organization、管理员 provider 列表或 `get-session` 猜测当前登录 provider；四个内部 assurance 字段仍然不出现在 `get-session` DTO。

## 客户端顺序

1. 点击退出时读一次本接口，不轮询、不持久缓存。
2. `target:null` 使用现有本地退出。接口失败时也保留本地退出路径，不声称上游已退出。
3. `protocol:oidc` 使用现有 `POST /api/auth/sso/oidc/logout/:providerId`，请求空 JSON body；响应 `localSessionRevoked/upstream/url` 区分 `requested`、`not_supported`、`unavailable`。跟随服务端返回的 URL；无 discovery `end_session_endpoint` 只完成本地退出。
4. `protocol:saml` 使用现有 `POST /api/auth/sso/saml2/logout/:providerId`，沿用固定、受信任的 `callbackURL` 和原生导航/重定向处理；原生成功为 `302`，保留原来的签名请求、关联、重放保护和审计。不要把它当成 OIDC 的 JSON 响应。
5. 两个实际退出端点仍独立 fresh 检查当前 session/provider。读取目标和退出之间发生撤权、换会话或配置变更时，旧 descriptor 不提供权限，客户端执行本地退出或显示实际失败即可。

描述符不会结束本地会话，不创建上游退出 nonce，不改变隐藏 assurance。上游回调只能证明该次请求返回，不承诺供应商所有全局会话均已结束。

## 回归边界

新增回归复用 `lib/enterprise/http.db.test.ts` 的实际 OIDC OP、签名 SAML IdP、Better Auth Cookie/native 入口和 PostgreSQL。覆盖两协议的精确目标、Cookie/native 主体优先级、普通会话、PAT/伪造/过期凭证、客户端指定 provider 拒绝、identity/provider/SCIM/archive 即时变化、Web 派生 SAML 会话与根过期，以及真实 SCIM 停用后空目标。没有替换授权函数、协议验证器或数据库。
