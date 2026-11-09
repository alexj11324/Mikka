# Enterprise 后台执行权限

## 目的与边界

强制 SSO 的 Organization 继续使用既有 Workspace 成员关系。已停用的成员、SCIM 身份或 Organization 不因后台任务获得额外访问；组织角色也不能替代成员资格。允许机器凭据的组织可以继续执行原有设备领取、恢复和 Workflow 生命周期，关闭 `allowMachineCredentials` 则拒绝这些访问。

HTTP 的缺失 principal、用户 ID、任务 ID、日志标签和客户端提供的工作流 ID 都不是后台凭据。已有显式 session、PAT 或 delegation 先接受其原有新鲜验证；失败后不切换到后台身份。该能力不写入可序列化的 `EnterprisePrincipal`，也不新增另一套成员真相。

## 受信任入口

| 入口 | 核验来源 | 持续约束 |
| --- | --- | --- |
| 原生设备 | 既有 `withDeviceRoute` 验证后建立的 device request context | 重新读取令牌所有者、撤销/过期状态；云设备保留设备、Workspace 和运行机器绑定 |
| Coordinator step | Workflow SDK 的当前执行元数据与确切注册函数 | 当前 Bot 的持久 leaseHolder 必须等于真实 workflowRunId，租约未过期，Bot 属于相同用户和 Workspace |
| Run recovery Cron | 两条既有恢复路由的实际 Authorization bearer | 能力包装器再次验证现有 CRON_SECRET；延迟 afterJob 回调重新建立有时效的能力，不复活已退出的上下文 |
| Run recovery timer | SDK 的确切 dueTimer 注册和当前 step | 原有 run-recovery hook token 的 World receipt 仍由相同 workflowRunId 持有 |
| Factory/thread step | SDK 的确切 Factory handoff 或 thread lifecycle 注册 | 持久 run、issue、computer binding、设备和冻结身份的用户/Workspace 一致；原有 owner 继续判断状态、attempt 与供应商生命周期；已退休云设备只允许同 run/owner/Workspace/device 的 ended machine 且 run 已终止 |

能力只在回调存活期间有效，最长五分钟。每次 Enterprise 检查仍验证当前策略和 SCIM 状态。设备调用和后台 wrapper 不会取代普通人类 session，也不绕过明确的 Workspace pin。

## 连接与拒绝契约

Workspace 会员锁仍先于 APP 事务。Enterprise 验证使用调用者已传入的 APP executor，已有事务通过原 `withDatabaseClient` 复用，不再额外 checkout。Factory 的精确 Workspace lease 只复用已被锁住的成员行；Enterprise principal 和策略每次重新检查。

`withTaskWorkspace` 将同 code 的 `WorkspaceError('workspaceAccessDenied')` 转换成该边界既有的 `ActionFailureError`。基础设施和编程异常原样传播，权限拒绝不会触发降级或自动 fallback。lease 仅在 Enterprise 检查成功后产生。

## 隔离验收

新增 `lib/enterprise/execution-authority.db.test.ts` 纳入 `test:enterprise-db` 和必跑清单。它使用全部实际迁移、PostgreSQL 17、APP/Workspace 各一个生产连接，覆盖实际原生令牌认证、queued claim、completion、Factory read、机器策略、成员/SCIM/令牌撤销、冻结身份、云设备 pin、原有人类/PAT 优先级、短期能力生命周期及已有 APP executor 复用。

测试仅替换 Workflow executor 的元数据和 World hook 传输边界，且默认没有执行上下文；数据库、身份/权限查询及设备/Factory owner 为实际实现。它不声称验证已部署 Workflow runtime、客户 IdP 或真实云设备供应商。OIDC/SAML 协议、Web 会话派生、手机和实时撤销继续由同一提交的现有 HTTP/PG fixtures 独立验证。新增用例必须在公开提交的 CI 运行后才登记通过结果。
