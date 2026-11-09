# #1512 CP38 — 6cc 原始 CI 与 Native 门禁闭合

本页是固定源码门禁记录。**生产模型验收仍为 0/2，issue 保持 OPEN。** 正式 R7 的 Claude fresh 证书转换失败单独记录，不能用绿色 CI 替代运行时发布。

## 固定来源

- Feature head: `6cc38aca620d16b25eebe0c8787747885a2cceb1`
- 实际 CI checkout: `16dcb17d4d20c32ffbc3f4d3e40b05a594d340f6`
- Tree: `9628e365dede1eaf6b45bab3ad35dfce11fbdace`
- 实际 checkout 有序 parents: `e189d7652fd2fce48b77a3697abf5bb177d8ebd1`、`6cc38aca620d16b25eebe0c8787747885a2cceb1`
- #1810 正常合并后 main: `8db16095f46be955df22f42914e0f89b6e5f3d11`
- 新合并预览 `0bb80be7d79ca559d073b5d944cba1a02c03070c` 与上述实际 checkout 的整树相同；它本身未执行，不为此重复 push/CI。

## 实际门禁

[CI 42653081708 / attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42653081708) 自然完成；15/15 workflow 成功。50 个唯一 Actions job 为40 success、10原条件skip；另有1个 GitGuardian success，因此51 check为41 success、10 skip。没有重试、取消或拼接旧932/8c结果。

Core 实际执行57 targets，最终 driver 的74个测试名逐项出现一次并PASS；它们属于组合执行，不伪造独立74项TAP汇总。Source 361/361，0 fail/skip；实际generator243 routes/315 methods，lint/types通过。Integration原29 targets全部执行，team-import为14641.96102ms，保留原15000ms期限、26导入/24模块/22场景与正常错误路径日志。strict 的7个 EXPECT 均true，依赖均success。

## 原始 Native 完整窗口

| 原窗口 | Native | 对照 | 原条件 |
| --- | ---: | ---: | --- |
| 完整登录 | 425 = 19 + 15 + 391 | Web 435 = 19 + 0 + 416 | 425 ≤ 435 |
| FIRST startup | 213 | Hosted 220 | 原pair=1；213 ≤ 220 |

Root 从唯一reader保存的五份 Git 原件独立核验字节/hash，复算24记录、12 checkpoint、8段、2280桶值和1293连续ordinal，错误0。完整email/PKCE/navigation/background窗口不变；unknown未扣除，细粒度diagnostics仍incomplete。

lifecycle workspace restored=false、phase=unchanged；sealed owner/peer before=false、after=true。smoke before/after=true且workspace restored=true；parity restored=true，分别保存。两renderer实际daemon为0.0.562 /111a8dfb8b227ac0441324339ff42e4328ea609a，不作为E2B runtime证明。

五对时延中位数Native2618.43ms、Hosted2218.84ms，Native慢399.59ms（约18.01%）；原合同未设时延阈值。parity原报告100屏、201/129600000差异像素，max ratio .00003935185≤.001；Root未查看PNG像素，不作视觉检查声明。三个独立进程Keychain和同一不可变包strict签名检查通过。

## 正式运行时失败

实际 [R7 42656120803/A1](https://github.com/alexj11324/Mikka/actions/runs/42656120803) 于16:47:38 UTC FAILURE。唯一原reader报告Claude before两CA路径为4e04…普通文件，fresh变为精确两跳证书链接。现有允许范围只有已证Desktop/Codex，不能无Claude控制证据扩展。完整mode/uid/gid/root仍待明确输入，未从差异行补值。

Desktop/Codex达到fresh_receipt；subscriptions/await-web/publish跳过。三个候选精确删除与空sandboxes/errors由原owner读取的cleanup原件确认。公开原报告完整保存在runtime文件中；root没有再次下载原日志或ZIP，没有同版本重试或新增例外。旧有效runtime仍不能替代最终daemon源码验收。

## 证据与资源

统一索引包含47个payload、5,029,007 bytes，逐文件保存Git blob、bytes、SHA256。Source初始label及修正记录同时保留。旧CP36/37不被改写。每份原Actions日志、Native/package ZIP均只有唯一reader；root复核使用Git blobs。

Native取证VM仅恢复artifact bytes；1vCPU/2GiB、15分钟绝对期限、无路由、未延期。实际238136ms，active CPU10003ms，ingress14867942B、egress313470B。已stop/delete，精确同project/name且resume=false的GET404；剩余资源0。账单金额未读取，保持unknown。

本checkpoint不关闭issue、不宣称生产PostHog链路/Replay/PNG完成，不把计划control或新合并预览写作执行。
