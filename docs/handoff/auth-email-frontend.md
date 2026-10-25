# Mikka 验证邮件与密码恢复：Claude 接口交接

这份交接供实现现有认证界面中的最小交互。保留原布局、组件、Google 登录入口和视觉设计，不重构认证 UI，不引入新的表单框架。

后端冻结版本：`73f1769697984d6a0d3215e5b644ad5be803fa93`，分支 `codex/issue-172-byos-foundation`。它已经包含 `fa6679def6cfb7c23dd9425a134674dccc090e2b` 的 BYOS 绑定补丁。部署与真实发信状态由父线程单独确认；不要在旧 Preview 上把接口缺失误判成新实现失败。

## 一、页面只需补什么

1. 在现有登录／认证错误区域提供用户主动点击的“验证邮箱／重新发送验证邮件”操作，配一个邮箱输入。不要在页面渲染或每次 Google 错误时自动发送。注册时后台已经自动尝试发送验证邮件，前端不要重复发送。
2. 在现有登录表单提供“忘记密码”操作，复用当前表单样式请求恢复邮件。不要要求用户在聊天中输入旧密码或安全链接。
3. 增加最小的新密码提交页，公共回调地址固定为 **`/mikka/reset-password`**；只有“新密码、确认新密码、提交、状态提示”即可。当前候选尚无这个页面，因此不能现在就向真实用户发送恢复邮件并声称可完成恢复。

中英文文案走现有 next-intl 资源。不要把本功能扩展成订阅配置、Infisical 登录或账号删除页面。用户不需要安装或登录 Infisical。

## 二、同源约定

下文 `ORIGIN` 指后台 `BETTER_AUTH_URL` 配置的精确 HTTPS origin，不含 `/mikka`、尾斜杠、查询或 fragment。前端应运行在该规范 origin；不要绕过跨域拒绝。请求可以使用现有 `authClient`，也可使用下面的同源 JSON fetch；不携带 operator key、Infisical token 或其他服务端凭证。

```ts
const response = await fetch('/mikka/api/auth/send-verification-email', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email }),
})
```

浏览器自己设置 Origin，不要手写它。不要重复添加 `/mikka` 前缀。只读页面中没有可供前端使用的 Resend 密钥。

## 三、发送验证邮件

**请求**：`POST /mikka/api/auth/send-verification-email`

```json
{ "email": "用户填写的邮箱" }
```

可省略 `callbackURL`，推荐省略。若明确提供，只能使用后台规范 origin 下的 `/mikka/sign-in`；不要传语言前缀地址、任意 `next` 跳转或外站地址。

**公开响应**：符合条件、账号不存在、已验证的匿名请求，以及邮件投递失败，不按账号存在性返回不同成功提示。

```http
HTTP/1.1 202 Accepted
Cache-Control: no-store
```

```json
{
  "status": true,
  "delivery": "unconfirmed",
  "message": "Request processed. This response does not confirm whether an email was sent."
}
```

`status: true` 是请求处理结果，**不是已发送／已送达证明**。建议统一文案：“请求已处理。如账号符合条件，请检查邮箱；此提示不代表邮件已送达。”不要显示账号不存在、已注册或已发送成功。服务端另行记录脱敏的投递失败，前端没有投递状态查询接口。

**邮件链接**由后端生成；前端不要自行构造 token 或 nonce。其消费端是 `GET /mikka/api/auth/verify-email`。验证链接 15 分钟有效，有一次性 nonce，绑定签发时的 Mikka 用户 ID／邮箱；重放、过期、错绑或账号删除重建后复用均拒绝。

消费时 callback 必须为邮件原有的完整规范 URL，不能改成 `/` 或相对路径。成功返回 **302 到 `ORIGIN/mikka/sign-in`**，不会自动创建登录会话。用户随后可继续现有 Google 登录；不要承诺点击邮件后已经登录。成功跳转不会附带验证 token，也没有 `verified=1` 参数，前端不能凭普通登录页访问推断验证刚成功。

## 四、请求密码恢复邮件

**请求**：`POST /mikka/api/auth/request-password-reset`

```ts
await fetch('/mikka/api/auth/request-password-reset', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email }),
})
```

推荐省略 `redirectTo`。后端发出的链接固定回到 `ORIGIN/mikka/reset-password`。如提供 `redirectTo`，只能是这个规范目标。公开成功响应同上一节：**202／`delivery: unconfirmed`**，不表明存在账号或邮件已送达。

用户打开邮件中的标准 Better Auth 链接：

`GET /mikka/api/auth/reset-password/<邮件中的不透明令牌>?callbackURL=<固定完成地址>`

这个 GET 校验令牌并跳到 `/mikka/reset-password?token=<不透明令牌>`；它本身不修改密码、不消费重置令牌。过期／不存在的令牌会跳到固定页面并带 `error=INVALID_TOKEN`。不要把完整链接复制到聊天、遥测、录屏或日志。

## 五、新密码页面

进入页面后，只将 `token` 读入组件内存，并立即用 `history.replaceState` 清除 URL 中的 token，随后再加载分析／遥测或发起其他交互。不要写入 localStorage、sessionStorage、模型消息、错误报告或表单持久化。没有 token 或收到 `error=INVALID_TOKEN` 时显示“链接无效或已过期，请重新请求”，不要继续提交或自动循环请求邮件。

两个密码框使用现有组件，`type=password`、`autocomplete=new-password`；本地确认两次一致。服务器当前密码长度为 **8–128 个 JS 字符单位**，服务器验证仍是最终依据；不要另加未经决定的强度规则。密码仅用于下面的同源 POST，不进入聊天或前端日志。

**提交**：`POST /mikka/api/auth/reset-password`

```json
{ "token": "仅内存中的不透明令牌", "newPassword": "仅用户在安全表单中输入" }
```

成功 **200**：`{ "status": true }`。后端在同一事务中更新密码、原子消费该令牌，并撤销被重置用户的既有服务端会话。它不自动建立新会话。成功后清空密码／token 状态，引导到现有正常登录入口；不要把其他多账号会话强制改成被重置的账号。

**语言路由是待页面实现的验收点**：后台只接受固定非语言前缀的完成地址。当前 Next 响应头规则覆盖 API 和 `/mikka/reset-password`。如果 next-intl 将新页面实际落到 `/mikka/en/reset-password` 等地址，页面实现必须保证每个真实落地路径也有 `no-referrer`／`no-store`，并立即清除 token；不得只根据 API 检查通过就宣称页面安全。不要为了跳过这个工作把 callback 放宽为任意语言／任意 URL。

## 六、错误和限流

| 场景 | 当前后端行为 | 最小 UI 行为 |
| --- | --- | --- |
| 请求邮件被处理 | 202，`delivery: unconfirmed` | 统一不确认投递的提示 |
| 服务端完全缺少邮件密钥 | 请求前统一 503，`AUTH_EMAIL_DELIVERY_UNAVAILABLE` | 服务暂不可用；不要索取用户密钥 |
| Resend 拒绝、超时或后台发送失败 | 对外仍为统一 202，后台记录固定失败事件 | 不显示已发送／已送达，不猜账号存在性 |
| 非法邮箱／请求体 | 400 等库验证错误 | 使用现有表单校验提示 |
| 非法 Origin／callback | 400 或 403，依拦截阶段而定 | 请求未完成，不自动放宽或换目标 |
| 验证链接缺字段、过期、重放、错绑 | 400，通常 `INVALID_TOKEN` | 提示重新请求验证链接 |
| 重置 token 无效、过期或重复 POST | 400，`INVALID_TOKEN` | 清理敏感状态，重新请求链接 |
| 新密码太短／太长 | 400，`PASSWORD_TOO_SHORT`／`PASSWORD_TOO_LONG` | 只显示长度规则，不回显密码 |
| HTTP 限流 | 429，库响应含 `X-Retry-After` 秒数；不保证有 `code` 字段 | 倒计时后允许手动重试 |
| 已有会话对其他邮箱请求验证 | 库可返回 `EMAIL_MISMATCH`；自己已验证可返回 `EMAIL_ALREADY_VERIFIED` | 不利用它探测其他账号；正常验证／登录引导 |

当前 HTTP 规则：验证邮件请求 3 次／60 秒，恢复邮件请求 3 次／60 秒，验证链接 10 次／60 秒，重置 POST 5 次／60 秒；注册／登录保留 Better Auth 的 3 次／10 秒默认规则。HTTP/IP 存储当前按实例，不能当作全局反滥用保证。

另外，后台通过数据库对每个收件人、每种邮件类型、每个分钟桶只允许一次发送，覆盖自动／手动路径和不同服务实例。触发这个保护仍返回统一 202。页面可显示 60 秒重试冷却，但它只是体验提示，不能替代后台限制。不要忙轮询或自动重发。

## 七、保持现有安全与合法流程

- 邮件验证不会放宽 Google 同邮箱关联策略；Google OAuth 仍使用现有稳定 hub `https://app.aspectlylabs.com`，再回原 Preview。
- 不读旧密码／密码哈希，不直改 `emailVerified`、account 或 session；不删除重建用户来完成验收。
- 原有密码登录和注册会话行为保留；没有全局新增“未验证不可密码登录”策略。
- 重置可按 Better Auth 原有行为为 OAuth-only 用户添加 credential；这依赖用户实际控制邮箱，不是读取 Google／Mikka 原密码。
- 发信是 Next `after` 后台工作，没有新增持久邮件队列，也不承诺失败自动重试；不得把 UI 写成“我们会自动重试直到送达”。
- 不把邮件服务凭证或 BYOS 全局 operator key 交给前端。`fa6679d` 的短时绑定 proof 是另一条受控操作，不是邮件恢复参数；本 UI 不生成或收集它。

## 八、冻结验证与接线边界

运行代码冻结于 `73f1769697984d6a0d3215e5b644ad5be803fa93`；本交接文档是其后的纯文档提交，不改变 API。该版本包含 `fa6679def6cfb7c23dd9425a134674dccc090e2b`。

已完成的 Linux 检查：

- `node scripts/test-auth-email.mjs`：真实隔离 PostgreSQL／Better Auth，12/12。
- `node --import tsx --test lib/auth-config.test.ts lib/auth-error.test.ts lib/auth-callback.test.ts lib/auth-return.test.ts`：15/15。
- `node --test scripts/check-migrations.test.mjs scripts/migration-order.test.mjs`：11/11。
- `tsgo --noEmit`、全库 oxlint、UI policy 检查通过。
- 原始配置的完整 Linux／Docker Next webpack 构建退出 0。
- 同一冻结产物启动真实 Next 服务后，通过注册建会话、Next after 发送回调、绑定用户的验证与安全响应头、重放拒绝、匿名统一响应和恢复邮件回调六项检查。外部邮件网关是假实现，不能当作真实收信验收；新密码页面尚未实现。

完整迁移命名检查另有 7 项与修改前基线相同的旧 BYOS 时间戳问题，本补丁未更改任何迁移。不能把整个 `pnpm lint` 声称为通过，也不通过重命名已落库文件或关检查解决。

前端完成后冻结组合版本，重跑云 Linux 类型、构建与浏览器交互：请求邮箱、统一提示／冷却、验证跳转、缺失／过期／重放 token、新密码长度与确认、失败恢复、成功清空敏感状态以及实际语言路径响应头。不要用孤立组件、旧 Preview 或模拟网关代替最终真实收信与正常登录验收。

真实邮件及账户操作由后端操作者按单独批准范围执行；前端不收集服务端 Resend／Infisical／BYOS operator 凭证，不索取旧 CLI token，不删除重建账号或修改验证状态。操作证据和安全链接不提交到仓库；必要脱敏证据通过父线程交接。
