# #1284 / #1403 定点修正与诊断证据

本组保存同一权威实现的两个连续贡献：[#1403](https://github.com/alexj11324/Mikka/pull/1403) 的 a6 → [d3ea4c2](https://github.com/alexj11324/Mikka/commit/d3ea4c2f8229dd7fb22ddf00e1e33ca1c59b3d19) → [89f1829](https://github.com/alexj11324/Mikka/commit/89f1829e9620c5f59013781adc107228a666413c)。没有另起定时器实现或修改 peer 的源分支。公开源码的 commit、tree、parent 和分支已由 root 经 GitHub 读回核验。

## 版本与实际验证

| 材料 | 精确版本 | 实际结果 |
|---|---|---|
| handoff-d3ea | 原 a6 产品加同一最终回归 | 22 项：20 pass / 2 fail / 0 skip |
| handoff-d3ea | 本地 92e6ba07；公开 d3ea，tree 6b32408cbdad681d1d9b319c230e3d5c6a87f50c 完全相同 | 22/22；完整树 typecheck、三文件 lint、diff check 通过 |
| diagnostics-89f1829 | 原 d3ea 产品加同一最终诊断断言 | 22 项：14 pass / 8 fail / 0 skip |
| diagnostics-89f1829 | 本地 24aa29397d8eb6b01067ad1c6a019724ff7c75ff；公开89f1829，tree16773655c04717b1d0c629a66f450b69da184d50完全相同 | 22/22；完整树 typecheck、四文件 lint、diff check 通过；实际 auditRepository() 与 staleAllowlistEntries() 均为空 |

两轮的22项有大量重叠，不能相加声称44个独立场景。每一轮自己的 RED/GREEN 测试文件字节相同；诊断轮扩充原断言，原来两项接力/父运行回归仍在。执行命令、起止时间、退出码和日志散列均保留在各目录的原始 manifest/validation 中。GitHub 公共提交与 Docker 本地 checkpoint 的 tree 完全一致，未把本地命令伪称为在另一 commit 上执行。

## 解决的具体问题

d3ea 的三个文件修正 existing 候选先释放 election 再 nudge，保证异步唤醒下 successor 能参加选举；同部署 lifetime 接管除原前任参数和年龄条件外，校验 SDK 保存的 $parentRunId。后者是宿主身份合同校验，不声称已经证明公开用户利用入口。

89f1829 的四文件增量为拒绝条件添加闭集 detail，记录已读的安全 metadata，并通过既有 CodedError/logCodedError 输出经过过滤的原因 name/code。root 与独立 reviewer 已逐文件审阅；准入谓词、SDK调用顺序/数量、force/取消条件保持，没有新增DB/SDK查询或轮询。日志不输出原始SDK message/body/inputs/cookie/hook token/native SID。Workflow持久错误仍为原固定 RetryableError 与1m重试间隔，不附带原始SDK cause。

## 边界与剩余步骤

本组是 Docker Agentic Platform Large 内的定点单元、类型、lint、错误策略与静态审阅证据。没有运行新PG套件、完整生产构建、模型请求或生产迁移。最终 #1403 整合 head 的构建/CI、Web/worker发布与生产恢复仍应单独记录。

receipts 中的生产快照是15:07–15:08 UTC的只读基线：ALEX67原Task仍review/blocked、revision11，保留原候选816513cf-503e-4ccc-b708-4bbd565206f3，最近Review尝试没有Run。记录中的Docker stopped是当时管理接口观察；之后为完成本诊断修正按需恢复了同一沙盒，不表示此期间始终停机。

#1284 的 CC/Codex双订阅、显式v1/v2、非终态配置冻结和ALEX66/72/73正常Owner接受已在[前一组49文件生产证据](https://github.com/alexj11324/Mikka/blob/0acf65ab2f79ee049bf280aefca7d5d5510d3411/docs/acceptance/evidence/issue-1284/production-20261105-1436/README.md)中保存。ALEX67等待当前修复发布后正常重试，之后按原收尾计划停用自己的测试Profiles并保留历史。DeepSeek coding API仍按Alex指示排除，没有余额探测或测试请求。

本组的新冻结manifest和官方auditEvidence报告独立保存。旧贡献的manifest/validation、真实RED、失败历史和源码均原样保留；审计通过不能替代最终生产验收。

