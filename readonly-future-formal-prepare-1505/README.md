# Future formal-window fresh GitHub child — disabled local preparation

本包只准备可能需要的下一次 fresh readonly-child 源码。**没有激活入口、创建 Git 对象、更新 ref、读取生产凭据、预留窗口或调用云资源。** 实际 APP、APP tree、R7 与 entry/hard 时间仍未知，没有填入旧值。

## 何时使用

默认等当前实际消费者（包括 #1506 批次）的自己的精确 child cleanup 完成后，再由 root 在实际交接点检查共享冒烟账号和源版本。如果账号仍有任何已存在的 GitHub child，禁止重复 prepare；现有 helper 在 mint 之前和安装事务内都执行 `assertVacant`，失败不会覆盖已有连接。

若某个合法、仍活跃的 child 已连同精确来源、原 receipt、有限有效期和清理责任完成授权移交，应复用该明确交接的 child，跳过本包。不得为了让新 prepare 成功而撤销、续期或替换其他消费者的 child。本包既不判断当前生产连接，也不声称当前账号已经空闲。

`observed-context.json` 只记录 root 上次观察到的已关闭 carrier `816874b4d522d97d674539468a7cbd7a7ca1f71c`、tree `e0e5f2b286330f324245e990b3c150df8c1096c4`。该值来自已完成的21:24清理和21:29:14释放记录，**只是观察提示，不是未来激活绑定**。实际 source/carrier 在激活前必须重新读取；当前 APP/tree/R7 和时间字段均为 null。

## 固定来源

工作流模板逐字节复用 `readonly-trusted-carrier-preparation-1505` 的修正后版本：**11668B**，SHA256 `6e49a194122e1769cb23e3bed7277677070202f4171a6879abf95cac8afb8be8`。`provenance/hash-binding-correction.json` 保留 runner/test 内嵌摘要修正，不能恢复旧摘要。

五个 helper 逐字节复制，没有代码改动。它们已有 **47/47 PASS、0 skip** 的同字节离线证据；本次只读取该证据，**没有重跑47项测试**。

对照成功 prepare `42689909155/A1`、实际 head `683b5010bec31bb8515fba73dfaa0f68bc1898df` 的缓存源码，六项 marker 替换后，加上明确记载的历史首行注释和 job-if，能够逐字节重建当时 active/closed workflow。成功源码的首行注释写的是过去20:04窗口；这是唯一非执行注释差异。`historical/binding.json` 中的 `head=a83b...` 是当时 PR head，不能拿来代替 prepare head `683b...`。

## 本地使用

先复制 `bindings.pending.json` 为本目录内的新文件 `bindings.ready.json`，实际就绪后只填以下六个字段：

| 字段 | 必须绑定的实际值 |
| --- | --- |
| `mainCommit` | 激活时确切 APP/main commit |
| `mainTree` | 上述 commit 的完整 tree |
| `orderedParents` | `[mainCommit, closedCarrierCommit]`，顺序固定 |
| `closedCarrierCommit` | 当时自有 trusted carrier 的实际已关闭 head |
| `entryDeadlineUtc` | 新实际入口截止时间 |
| `hardEndUtc` | 新实际硬截止时间，至少覆盖 entry 后15分钟预算 |

时间格式为 `YYYY-MM-DDTHH:MM:SS.000Z`。不要填写未来占位窗口或沿用历史时间，不要自动延长窗口。整个实际资源段仍须覆盖排队、prepare、验证和精确清理。

```bash
python3 readonly-future-formal-prepare-1505/render.py \
  --bindings readonly-future-formal-prepare-1505/bindings.ready.json \
  --out readonly-future-formal-prepare-1505/prepare.rendered.yml.review
```

输出仅为本地 **`if:false`** workflow 及 `.json` 源绑定报告。Renderer 只替换六种原 marker；不会生成 active workflow，不执行内嵌 Python，不调用 Git/网络/凭据/数据库。已存在的输出不会被覆盖。

root 需另外核实当时真实 APP/tree、R7 run/attempt/source/worker/templates 和所需发布门槛，并把实际上下文记录下来。`observed-context.json` 的 R7 字段在本包中保持 null；renderer 不声称已经验证 R7，也不会向原 workflow 或普通 Task 增加 R7 字段。

## 真实激活与后续清理

只有实际需要新的 child 时，root 才在检查真实共享消费者、明确窗口和源绑定后审阅输出，并单独应用原已审 job-if。新 operator 以完整 APP tree 为基底，ordered parents 恰好 `[APP, current closed carrier]`；相对 APP 恰好新增 workflow 与五个 helper，全部 `100644`。不得继承旧 carrier 其他操作文件，不得改产品文件、使用单父替代、改变 GO 或凭据范围。

原工作流保留两个 `cancel-in-progress:false / queue:max` 队列、三个时钟保护块（合计六次 check 调用）、三次 actual-main 读取、五个原 Infisical OIDC scope、15分钟 job timeout 和发布前 helper 检查。正常源/tree/blob/parent 回读后才能执行自有 ref 的非强制 CAS；这些操作均不属于本包。

新 prepare 成功后保存**本次自己的原件 receipt 和原 run/head/artifact 绑定**。其后的精确 cleanup 必须消费这份新的 receipt；不能用历史 `42689909155` 的 receipt 清理新 child。若不需要新的 child，不运行本包。准备、使用和清理完成即关闭入口并释放实际资源段。

## 本次轻量核验

`verification.json` 记录：五 helper 摘要/内嵌绑定一致、六种 marker 及出现次数完整、三个内嵌 Python 块只编译不执行、YAML 的 if:false 和原队列/作用域不变、历史 source 精确重建、未填实际值在写文件前拒绝。没有完整测试套件重跑，没有新的原件下载或生产执行。`manifest.json` 冻结本包文件供 root 随后记录到 Git evidence；本任务没有创建该 Git 记录。
