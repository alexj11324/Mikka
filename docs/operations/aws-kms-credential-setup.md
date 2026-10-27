# 给 Codex：为 Mikka 密码箱搭建 AWS KMS，并把配置写进 Infisical

你在 Alex 的 Mac 上操作。目标是为「已保存的登录」（#180）搭好 AWS KMS 信封加密的底座。

完整设计见 https://github.com/alexj11324/Mikka/issues/180#issuecomment-6450064407 第 3 节。
Alex 2026-10-27 的决定：

- 用 AWS KMS，第一版就直接用，不经过 Infisical 过渡；
- Vercel 通过 OIDC 免密钥访问 AWS。

## 硬性规则

- **不创建任何长期 AWS Access Key**，包括 IAM user 的 access key 和 root key。应用和 broker
  只通过 Vercel OIDC 换取临时凭证。
- 你自己操作 AWS 时，用 Alex 已登录的身份（`aws sso login` 或控制台）。不要把这个身份的任何
  token 写进 Infisical、文件、仓库或输出。
- 下面要写进 Infisical 的值都是 ID 或 ARN，不是机密。照常不要回显任何 token。
- 写 Infisical 时遵守 `~/.codex/rules/infisical-api.md`。
- 不改任何生产数据库，不部署。
- 遇到需要 Alex 本人的步骤就停下来，告诉他具体要做什么：开账号、付款信息、root MFA、
  Vercel 团队设置的权限。

## 0. 前提（需要 Alex 本人确认）

1. 有一个 AWS 账号，专门给 Mikka 用最好。root 已开 MFA，平时不用 root。
2. 有一个日常管理身份（IAM Identity Center 用户或管理员角色），Codex 用它操作。
3. 区域用 `us-east-1`（Vercel 函数默认在 iad1，就在这个区域）。

## 1. 开审计日志

确认账号里已有覆盖全部区域的 CloudTrail trail（管理事件）。没有就建一个，名字 `mikka-audit`，
写进一个专用的 S3 bucket。KMS 的每次加密、解密都会记在这里。

## 2. 建 KMS 钥匙（Preview 和 Production 各一把）

| 环境 | 别名 |
|---|---|
| Production | `alias/mikka-credentials-prod` |
| Preview | `alias/mikka-credentials-preview` |

每把钥匙的设置：

- 类型选 Symmetric，用途 Encrypt and decrypt；
- 设为 **Multi-Region** 主钥匙（以后某个区域出问题，可以在另一个区域复制出副本）；
- 开启自动轮换（`aws kms enable-key-rotation`）；
- Key policy 先只放账号 root 的管理权限（AWS 默认那条）。第 4 步建好角色后再加两条授权。

## 3. 在 AWS 里登记 Vercel 的身份提供商（整个账号只建一次）

IAM → Identity providers → Add provider：

- 类型：OpenID Connect
- Provider URL：`https://oidc.vercel.com/mikka-dev`
- Audience：`https://vercel.com/mikka-dev`

Vercel 团队是 `mikka-dev`，项目是 `mikka`（`prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`）。

## 4. 建四个角色

| 角色名 | 给谁用 | 权限 |
|---|---|---|
| `mikka-credential-app-prod` | Production 主应用 | 对 prod 钥匙：`kms:GenerateDataKey`、`kms:Encrypt` |
| `mikka-credential-broker-prod` | Production broker | 对 prod 钥匙：`kms:Decrypt` |
| `mikka-credential-app-preview` | Preview 主应用 | 对 preview 钥匙：`kms:GenerateDataKey`、`kms:Encrypt` |
| `mikka-credential-broker-preview` | Preview broker | 对 preview 钥匙：`kms:Decrypt` |

信任策略（以 prod 为例；preview 把 `production` 换成 `preview`，`<ACCOUNT_ID>` 换成账号 ID）：

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/oidc.vercel.com/mikka-dev" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.vercel.com/mikka-dev:aud": "https://vercel.com/mikka-dev",
        "oidc.vercel.com/mikka-dev:sub": "owner:mikka-dev:project:mikka:environment:production"
      }
    }
  }]
}
```

权限策略（以 app-prod 为例）：

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["kms:GenerateDataKey", "kms:Encrypt"],
    "Resource": "<PROD_KEY_ARN>",
    "Condition": {
      "Null": {
        "kms:EncryptionContext:userId": "false",
        "kms:EncryptionContext:credentialId": "false",
        "kms:EncryptionContext:origin": "false"
      }
    }
  }]
}
```

broker 角色同理：Action 改成 `["kms:Decrypt"]`，条件相同。这个条件的意思是：不带
userId、credentialId、origin 三项上下文，加密和解密都会被拒。

角色建好后，在对应钥匙的 key policy 里各加一条 Allow，把上面同样的 Action 授给这两个角色。
不要给任何角色 `kms:*`、`kms:ScheduleKeyDeletion`、`kms:DisableKey` 或 `kms:PutKeyPolicy`。

## 5. 防误删和告警

- 在 EventBridge 建一条规则：对这两把钥匙的 `ScheduleKeyDeletion` 和 `DisableKey` 事件发告警，
  通知 Alex 的邮箱（用 SNS）。
- 记录下来：钥匙删除有 7–30 天等待期，期间可以 `CancelKeyDeletion`。

## 6. Vercel 开启 OIDC

在 Vercel 项目 `mikka` 的 Settings → Security → Secure backend access，开启 OIDC Federation，
Issuer mode 选 **Team**（issuer 就是 `https://oidc.vercel.com/mikka-dev`）。之后部署里会自动有
`VERCEL_OIDC_TOKEN`，不需要存。

如果你没有这个设置的权限，停下来告诉 Alex。

## 7. 写进 Infisical（Mikka 项目）

Production 写进 `prod:/aws`，Preview 写进 `preview:/aws`，每个环境各写这 5 个：

| 名称 | 值 |
|---|---|
| `AWS_REGION` | `us-east-1` |
| `AWS_ACCOUNT_ID` | 12 位账号 ID |
| `CREDENTIAL_KMS_KEY_ARN` | 该环境钥匙的 ARN（写 key ARN，不写 alias） |
| `CREDENTIAL_APP_ROLE_ARN` | 该环境 app 角色的 ARN |
| `CREDENTIAL_BROKER_ROLE_ARN` | 该环境 broker 角色的 ARN |

然后让这些值通过 Secret Sync 进入 Vercel 对应环境：

- 优先加到现有同步到 Vercel 的路径或 sync 里（例如 `prod:/vercel`）；
- 也可以给 `/aws` 新建一个 Vercel Secret Sync，Production 对 Production，Preview 对 Preview。

**不要**把 AWS 管理身份的任何东西放进 Infisical。

## 8. 验证（只用你的管理身份做，不改应用代码）

1. 用 `aws kms describe-key` 和 `get-key-rotation-status` 确认：两把钥匙已启用、是 Multi-Region、
   已开轮换。
2. 用 `aws iam get-role` 确认四个角色的信任策略，`sub` 精确到项目和环境。
3. 回环测试（用 prod 钥匙）：
   - `aws kms encrypt` 加密一个假字符串 `test`，带上
     `--encryption-context userId=u1,credentialId=c1,origin=https://example.com`；
   - 用同样的 context `decrypt`，应该成功；
   - 换成 `userId=u2` 再 decrypt，**必须失败**。
4. 确认 CloudTrail 里能看到这几次 Encrypt 和 Decrypt 事件，事件里带 encryption context。
5. 确认 Vercel 项目已开 OIDC；Infisical 的 `prod:/aws` 和 `preview:/aws` 各有 5 个值，
   并且已同步到 Vercel 对应环境。

「Vercel 部署里用 OIDC 真的换到角色」这一项，留到密码箱 PR 的 Preview 验收时再测，
这一步不需要。

## 9. 回报给 Alex

- 账号 ID，两把钥匙的 ARN 和别名，四个角色的 ARN（这些都不是机密）。
- 每一步的结果，分成「完成」「失败」「需要 Alex」三类。
- 验证第 3 步换 userId 解密失败的原始错误码（例如 `InvalidCiphertextException`）。
- 明确说明：没有创建任何长期 access key；没有把管理身份的凭据写进任何地方。
