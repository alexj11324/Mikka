# #1506 安装凭据进程范围：固定执行与审查证据

对应修正源：`30e54e5f9e97ed059bb9121edeeb20fa2578e286`，tree `2fa4d7e09a90e7a75151e9ae4065245b391ea366`，唯一 parent `01b302385666dc5b7a1535a335ef1d953c5d12b8`。

`source-review.json`、`independent-review.json`、`caller-permissions.json`、`scope-change.patch`、`red.log` 和 `green.log` 都是此前封存原件的逐字副本，SHA256 与 #1810/6736905024 及原源码记录一致。没有生产凭据、模型请求、平台私有 API 响应或 CI 原日志。`execution-receipts.json` 将原命令、退出码、文件绑定和版本边界整理为可读索引。

RED 为14项中9 PASS/5 FAIL，GREEN为原8项加新增范围合计22/22、0skip。两次默认场景的 RED 都由实际 pnpm10.34.3 的 postinstall 子进程观察到 token 而失败；GREEN验证默认空、覆盖外层旧变量、只读显式传入。临时包没有依赖，网络禁用，token为假值，presence receipt只有布尔值。

测试在已逐文件对齐固定源的隔离工作树运行；该工作树 HEAD927 不被冒充为 b87/pure 的完整 checkout。新增11文件在验证前后不变，远端pure tree与隔离Git index完全一致。独立审查核源码与原测试保留，没有声称重复执行。

本证据提交只添加本目录文件，不改变产品源码。#1810的组合分支当时仍为b87，尚未继承30e；旧b87 CI全绿与此处定向验证分别保留。#1506生产首字目标尚未达成，新六轮尚未运行。
