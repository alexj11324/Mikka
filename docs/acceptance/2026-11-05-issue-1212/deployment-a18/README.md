# #1293：生产发布与公共版本核验

本记录只证明这次代码发布及公开版本，不代表固定任务一小时性能对比、真实审批事件或三模型生产验收已通过。

#1269（已批准写入卡片）、#1281（电脑状态）、#1283（待审批动作）的代码经整合 PR [#1293](https://github.com/alexj11324/Mikka/pull/1293) 合入 main，squash 为 `a18d22a9d4b6b067297a72eb37205493be4f0b2b`。整合 PR 的精确 head 是 `43328f2e41a08d25b0a4210a4f31297cae44dfdf`；33 项检查结束，28 success / 5 条件 skip。

## 实际发布

- [Web deploy 41939614946](https://github.com/alexj11324/Mikka/actions/runs/41939614946) success。实际 build、upload、释放队列前的公共版本核验步骤均 success；不是只改文档的跳过运行。
- [Device gateway 41939614654](https://github.com/alexj11324/Mikka/actions/runs/41939614654) success。真实 runtime/channel/ticket 测试成功；部署 job 要求同 SHA main CI 成功，等待对应生产应用后更新既有 Worker 的具体步骤也 success。没有新建收费资源。
- **2026-11-05 00:22:13.050 UTC**，独立无认证 HTTP GET `https://app.aspectlylabs.com/mikka/api/version` 返回 **200**，`build` 精确等于上述完整 squash SHA。原始观测对象见 `public-version.json`。

该版本的祖先链还包含页面读取瘦身 PR #1219 的 squash `b9ddb7bb1238226909648a051007cf7fca8950a2`；GitHub compare 的 merge-base 已核对。本记录不能反推此前 b9ddb7b 上线时的精确公开版本窗口。

## 验收边界

三批原先各自的本地真实构建、正常 TestAccountPool 截图、源码与数据库回归已经在各自证据目录记录。它们不能替代此整合版本的真实生产事件、前后台切换、断线补拉和固定任务整小时观测。

指定 DeepSeek key 最近一次免费余额查询仍不可用；当前正常 smoke 登录又不是原 CC Factory Owner。既不换模型，也不把其他 Owner 的配置或历史执行当作原案例的新验收。

#1211、#1212 的正文仍要求固定真实任务的一小时前后数据与各自三路径验收。本次没有调整 Neon 设置、预算或 PostHog 告警阈值，没有创建任务、调用模型或写入测试业务数据。
