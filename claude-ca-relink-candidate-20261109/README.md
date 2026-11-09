# Claude E2B CA relink 候选

状态：本地候选，尚未取得本次官方 Claude-only 对照实证，不能据此宣称可合并或发布。没有创建 Git commit/ref/PR，也没有操作生产、模型或 VM。

## 固定源码与已知失败

- Source：`8db16095f46be955df22f42914e0f89b6e5f3d11`，tree `18b539c3541594cfa540d1e178985f00d03ab4fc`；parents `e189d7652fd2fce48b77a3697abf5bb177d8ebd1`、`8c423db291f8121980267cd48a24e428c992f618`。
- Root 转交的公开协调事实：release `42656120803/1`，build job `129295381232`，16:47:16 FAIL；Claude fresh_scan 中两条普通文件变为固定符号链接，原文件 SHA256 均为 `4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1`。本代理没有重复读取原日志或工件。
- #1782 owner 在原 Ops subject 做无 Mikka 的官方 Claude-only 派生对照（#1752/6745889610）；本包未将该计划写成已成功证据。
- 已读 fixed source 的 AGENTS.md、CONTRIBUTING.md，以及 systematic-debugging / verification-before-completion 清单。该目录只装入本次必要四个 Python/JSON 文件，无依赖安装。

## 三个变更文件

1. `scripts/e2b/e2b-certificate-relinks.json`：在原 320 行规则后仅追加两行 Claude-only 规则；不改原 Desktop、Codex 或通用证书行。
2. `scripts/e2b/e2b-finalization-files.json`：仅更新 `certificateRelinksSha256`，原 control 元数据、common/templates 全部不变。未捏造本次 controlRun/receipt。
3. `scripts/e2b/official-files.test.py`：保留原 29 个测试，1 处受新行为影响的参数更新；新增 5 个 Claude 测试方法。

| 路径 | 原 digest | 精确 raw link target | 范围 |
| --- | --- | --- | --- |
| `/etc/ssl/certs/1560546e.0` | `4e04ce0b…8255aa1` | `e2b-ca.pem` | Claude finalization |
| `/etc/ssl/certs/e2b-ca.pem` | `4e04ce0b…8255aa1` | `/usr/local/share/ca-certificates/e2b-ca.crt` | Claude finalization |

两条均使用既有 `providerRoot: true`，不加 mode 例外。完整 digest 写在源码和 conservation.json。原 matcher `official-files.py` 全字节保留，SHA256 `66911624af52df59ef715eb105af9a3025bacf12460105fadc7f87e4d2dd63b5`。

## 保留的边界

- 只接受明确源 digest 的 file→link、精确 raw target；最终 resolve 必须为 `/usr/local/share/ca-certificates/e2b-ca.crt` 且目标为 regular file。
- mode/uid/gid 不得变化；没有新造绝对 mode 规则。测试夹具沿原 Desktop helper 使用 0777，但这不是本次 Claude 官方对照的 mode 实测。
- provider root 仍可按原规则每次 boot 更新，其 resolved digest 必须是完整有效小写 SHA256；不要求等于旧 alias digest，也没有省略该证据。
- 安装期 `verify(manifest)` 仍拒绝相同变更；只有显式 Claude finalization 可接受。
- receipt 的 strict before==after、final kind、policy hash、entry counts、unique paths、字段对称保持；不能用 final 原始结果替换安装证明。
- CLI 原文件/字节/权限/身份与非名单路径继续受保护。原 Desktop 4e04 和 Codex a351 规则保持。

## 真实 RED → GREEN

命令两次相同：

```sh
python3 -B scripts/e2b/official-files.test.py -v
```

工作目录为本包 `candidate/`。Python 3.12.14，标准库，无 pip/npm/pnpm 安装。

- **RED**：16:57:48 UTC，在原 matcher/原 policy 上只加入新测试。实际 exit 1，34 test methods；6 个失败 subtest + 2 errors 都来自新 Claude 测试，原 29 个测试全部 pass。失败原件 `evidence/red.log` 20,350B，SHA256 `f3e61d9d20d27945dcf98aa5baf026d5a90fbca0322a73b70971d0e11f5991d3`。这里不是 8 个独立实验。
- **GREEN**：16:58:27–28 UTC，追加两数据行及摘要后，实际 exit 0，34/34，无 skip。`evidence/green.log` 6,284B，SHA256 `fc20dbf3d8120b95f0d44b0ca47e3f6c6a31de629fa584d083f403e0eba10e16`。
- 原第 695 行的 `claude scope` 正确形状拒绝，与新增允许行为冲突；按 root 明确授权，仅改为 Claude 使用旧 Codex a351 digest 的拒绝参数。没有删除/skip 测试，其他旧拒绝参数未改。去掉新增 class 并反转该一处参数，可逐字还原原测试文件。
- 新增验证包括正例与 strict 阶段拒绝、错误 digest/raw target/kind/mode/uid/gid、错误最终目标、CLI 与未知路径、receipt 篡改及安装证明替换。
- Python AST 2 文件与 JSON 2 文件解析命令均 exit 0；没有跑整仓测试、CI、构建或外部验收。

新增 relink 测试调用真实 policy loader、verify 和 validate_receipt；文件元数据及 resolve 使用本地测试夹具。既有 CLI 测试继续校验其自有临时文件。它们不能替代官方 Claude-only control，也不能证明生产发布通过。

## 交付与后续证据

`original/` 保留四文件原字节；`candidate/` 为可审阅候选；`candidate.patch` 是完整三文件差分；`product.patch` 只含两 JSON；`conservation.json` 记录原规则、matcher、测试逆变换和所有 old/new SHA/Git blob。

允许合入的证据仍需由 root 对接原 owner 的实际官方对照，确认这两条旧 digest、raw target、file→link、mode/uid/gid 保持和最终 regular provider root 的真实形状；本包不设新的业务 gate，也没有把对照任务执行一遍。根负责实际证据绑定与 ADR。当前没有新的正式六例或性能收益结论。

完整代码副本均可从固定 Git 对象及补丁重建；若后续保存精简证据包，可只存 source-index、差分、回执与日志，不必重复归档整份原/候选源码。
