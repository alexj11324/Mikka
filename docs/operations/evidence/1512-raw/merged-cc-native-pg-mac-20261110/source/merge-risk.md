**Merge risk: medium（中等；尚未满足合并与生产验收门禁）**

范围：`5852aa88 → a5027a36`，包含主干合流 M `c0fab838`、新增 PG 回归与 pending-only Native workspace SELECT。

**Alignment: good ✅**

- 对应 #1512“不增加数据库流量、不新增轮询”的约束：仅合并同一 Native batch 中尚未 dispatch 的等价 SELECT。主干合流保留 Inbox 行为、执行失败前置拒绝与原 trace correlation；五处冲突均有源绑定证据。

**Impact: large ⚠️**

- 触及 workspace 授权读取，租户隔离和撤权新鲜度是硬约束。队列按实际执行器、请求、用户、Native session、pin/principal 与固定 SQL family 分区；dispatch 前删除共享项，后续调用即使前一条查询仍 pending 也重新查库。每位调用者独立复制行并执行 pin/Organization 检查；事务、savepoint、延后与失效作用域旁路。
- 三个手写冲突保留两边业务/拒绝与隐私约束；两份路由产物匹配真实 canonical Node 输出（257 routes、345 methods），258 个生成输入全部匹配 M。

**Verification: decent 👀**

- 固定来源隔离验证：Node 24.22.1、PG17，M 模板 33/33，G Native 30/30；RED 25 项中仅指定两叶断言 `5≠1`、`4≠2` 及其父项失败，GREEN 25/25。两阶段数据库重新创建，源码前后绑定、原 stdout/stderr 与容器/volume/network 清理均有回执。
- 既有暖态 Web HTTP/PG 观测开销基准的 20 个源依赖与整份 lock 未变，可保留原测量归属；它不测新 Native 队列、生产 collector 网络或冷启动。
- **仍未通过的门禁：**正式 G head 的完整必需 CI；实际 Native 登录/启动查询不高于同源 Web；未改写验收条件的 Mac Node22 正式链路；#1512 要求的真实生产订阅运行及 trace/AI/Logs/Replay 完整证据。隔离 PG 成功不能替代这些门禁。

**Rollback cost: medium 👀**

- pending-only 差异本身不改 schema 或持久化凭据。发生回归时用普通 revert PR 成对撤回 R/G 的实现和新增回归期望，恢复逐调用 fresh SELECT；保留已合入 main 的 Inbox/迁移及其原测试，不用数据库回退掩盖代码问题。

**Error detection: decent 👀**

- 已验证的并发撤权、组织挂接、身份分区与事务用例直接检查授权结果，精确 RED 谓词不会把超时或其他失败算成有效证据。运行回执保留真实退出码、原始 TAP、源码身份和清理状态。
- 授权陈旧可能不产生异常；查询条数下降也不能单独证明正确。正式 Native 与生产证据仍须核对真实请求链、错误原因和权限结果。

证据：Native/PG 静态审查 `858cf1f0…`；三文件合流审查 `c62bb998…`；canonical `9258c6e9…` / M 树 `75ba70c0…`；执行入口 `d85b6bc8…`；开销适用边界 `dd92cf65…`；实际 PG 运行 [42745526739 / attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42745526739/attempts/1)；实际原件核对 `4a19a84ece023ce29c1965ee0e448ea4b8aa2cc5`，完整回执 `f4637dbb9e994e70de7bfa5477659d312445389b`，清理 `48e9145696c86476324b6cc9e71a8c0166779e59`。
