## 读图口径与覆盖范围

**7d 是查询窗口，不代表已经有 7 天数据。** 首个生产 trace 出现在 **2026-11-05 02:38 UTC**；创建看板时只有约 1.6 小时。实际首末时间、已观测小时数和缺失属性见下方覆盖表；没有数据的小时不补零。

- **采样与估算：**默认 10% trace 采样。表中 `sampled_*` 是实际收到的采样数量，`estimated_*_x10` 是乘 10 的估算。图只画估算值；不是精确全量，采样率改变或遥测丢失时需重新解释。数据库查询包括 `pg.query:` 开头的 SELECT、BEGIN、COMMIT 等调用。
- **时间：**横轴文字与覆盖表明确使用 **UTC**；项目时区是 Asia/Shanghai（UTC+8）。默认分别查询 24h / 7d；看板不覆盖各卡片日期。若手动覆盖日期，标题里的默认窗口不再适用。首末小时可能不完整。
- **字节：**来自返回行 JSON 大小的近似值，再按采样 ×10；**不是 Neon 网络传输或账单**。缺字节值不强行置零；有缺失时汇总只包含已知部分，缺失数量单列。未知 route 明确显示。
- **来源：**查询 production 的 `mikka-web` / `mikka-daemon`。目前只有 `mikka-web` 服务；`client_kind=daemon` 只表示服务端归因，不能证明 daemon 本地 spans 已接入。
- **错误：**统计 `status_code=2` 的 spans，同一次失败可能产生多个 spans。code 优先 `mikka.error.code`，回退 `error.type`；未埋点的 code/detail 明确标记。
- **预算：**下方复用日额度（500 GB 的 1/30，约 16.7 GB/UTC 日）和账期额度（Launch 套餐每月 500 GB）insights，保持原定义。值是最近一次已知供应商快照，可能陈旧；请结合[采集健康看板](https://us.posthog.com/project/670821/dashboard/2297143)判断。