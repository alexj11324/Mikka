# PG1 fixture 竞态修复与原失败证据

本增量只归档已存在的文字原件及必要 ops runner，不修改产品、不更新分支、不触发 CI/模型/数据库。父 evidence commit 固定50800dd16172e54aa5c6550b9d6543fb03dc8484；本前缀只为 evidence/1505-startup-timing-20261108/pg1-fixture-20261109/。

## 事实边界

- ci-new9ef保留实际旧CI PG1失败、完整pg1.log、首错源审与当时终态摘要；不被后续绿色覆盖。
- root授权的fixture调整仅测试夹具；local842f3ba（tree1071c59）、remote b7be7cc15f6b59dd11ae1c286640553432376fe6（parent9ef）的身份来自本轮root回执和随附local-commit/candidate。新CI42563364604已启动，synthetic ca9a2a0父[d72,b7]/tree13fa2d93是root捕获信息；此包不据此宣称全CI通过。
- 本地独立PG17.11上唯一原文件12/12、0skip、12.834s通过；原pg17-test.json/log保存完整输出。这不是正式六例、不是生产验收或完整DB矩阵。既有完整pnpm check的baseline FAIL仍未改写。
- 首次commit缺author identity失败仍保留commit.log及retry日志，未抹去。
- PG实例官方签名/包哈希和依赖检查、第一次minor选择断言、初次pgpass健康解析失败及安全stop都保留。root于04:42:32精确停止本实例，exit0、port关闭、pid文件消失以stop.json/log为准。未使用生产数据库/Infisical/model。
- release-queue快照仅代表2026-11-09 04:42单次未终态观察，不能作为当前绿灯或全局空闲许可。
- d72只读窄审仍保留“待实际组合CI”的原边界；旧0e性能/SQL数据不能推断d72结果。

## 收录、排除与完整性

全部原文字文件逐字复制，原manifest保持其原统计范围。index.json列出实际收录与排除项；不声称本增量含所有manifest成员。before.ts与fixture.diff属于Git-backed源和差异，排除正文但保留本地SHA身份；可以沿candidate/local-commit中的固定Git对象恢复源，不保证生成diff格式字节一致。

不包含PG下载包、runtime、数据库data、socket、庞大索引或空pgpass。仅必要小验证日志纳入。review.json中的diff键仅是路径/bytes/SHA索引，已核不含patch正文；限定输入秘密扫描未见未决凭据、私钥或签名URL嫌疑。ops runner是本次开发回归命令，不是执行入口授权。

索引不含自身hash以避免自引用，最终Git blob/tree/commit读回由归档回执提供。root独占最后ref fast-forward。
