# #1217：全新任务容器与最新主线的整合验收

产品 head：`c60850bf3e44228869485e4157832865f160e9d0`。父提交为原 PR `f0f2d077613a2de21a6cefb2f314a6dc8d93c89b` 与 main `2b25caad1608df6a2a54d5e18e798b3c9807ce89`。最终 tree：`5709b51c3f0c85feecef82202a3a23f248d7169f`。

这是正常三方整合。所有 25 个有内容文件的 Git blob 与一个删除条目均核准；公开 GitHub tree 与 Vercel 实测文件树精确一致。源码以该不可变产品提交为准，逐文件信息见 `source-blobs.json`。

## 实际结果

环境为 Vercel Large（8 vCPU / 16 GiB），Node 24.22.1、固定 pnpm 10.34.3、PostgreSQL 17。数据库为本次独立 loopback `*_e2e`，已在 finally 删除，未访问生产数据库。

| 门禁 | 结果 |
| --- | --- |
| Factory / continuity / inherited command / question receipt PG | 135/135，0 skip |
| Provider recovery / disabled identity / durable handoff PG | 7/7，0 skip |
| Cloud backend / unattended / task machine PG | 62/62，0 skip |
| Thread answer / continuation PG | 25/25，0 skip |
| 最终 cloud-limits | 29/29，0 skip |
| retained-deliverable probe | 11/11，0 skip |
| typegen / typecheck / lint / diff | exit 0 |

首轮 tree `9ba2c7d83ec9baf0a5e030b16d4a08e90628e80c` 的产品代码与最终 tree 相同；最终只调整一个诊断测试输入和过时 snapshot mock，并重新执行 cloud-limits、types、lint、diff。没有把前一轮测试记成最终 head 上重复执行；新 head 的完整 GitHub CI 独立运行。

## 冲突解决

- `ensureThreadMachine` 保留 #1217 的“新任务不要求父机 sandbox/running”，也保留主线新增的实际拒绝阶段诊断、ROLLBACK 与自身 lease 清理。
- Factory 同时保留本 PR 的原问题续跑 VM/owner/workspace/Bot/session/capability 边界，以及主线 report/deliverable 的 Owner 回答不得变成验证命令、候选不变和重放幂等回归。
- Provider recovery 保留主线的持久 handoff、旧 token 撤销后的 host 接管、并发 provisioning lease 和错误 receipt/停止请求拒绝；同时保留本 PR 对父机 state/lease/heartbeat 不变、独立任务机器及零外部网络的断言。

## 保留的真实失败

首轮 cloud-limits 为 **28/29**。新主线的 admission 诊断夹具通过 `botSandboxId=null` 产生拒绝，但这正是 #1217 删除的父机门槛，因此已不能代表 admission 拒绝。最终夹具改为授权 run 查询无匹配行，仍要求原拒绝、诊断 phase、敏感 canary 不进入日志、ROLLBACK、只清自己的 lease 和释放连接。没有放宽任何产品权限或将异常忽略。

`gates-1793832409_bbcd.json` 和其日志保留首轮失败；`fixture-v2-metadata.json` 与对应日志保留最终通过。日志中的 `PRIVATE-CREDENTIAL` 是诊断测试的固定合成 canary，不是外部凭证。

[独立复核](INDEPENDENT-EGRESS-REVIEW.md)已重新读冲突和实际调用链，并重算全部内容 blob 与两轮 16 个 gate 日志的 SHA；该审阅者没有自称重跑或调用真实模型。

## 尚未完成

正文要求的合并前真实 `test:local-loop` 付费 cloud leg 仍未完成。此前两次真实 DeepSeek 余额失败都发生在前置步骤，没有进入云机步骤；本轮没有重新付费调用，没有更换模型。真实生产三路径、父机 sleeping 时普通任务和 Factory 检查、Web deploy 和公开 build 精确 pin 仍须另行验证。PR 保持未合并。

