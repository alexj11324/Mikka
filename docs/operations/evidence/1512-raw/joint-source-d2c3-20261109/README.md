# #1512 CP49 — 联合源 d2c3 与实际发布回执

正式生产验收仍为 **0/2**。本 checkpoint 只关闭联合源与正常分支发布的证据链，不代表本轮 CI、Native、生产运行时或 PostHog 验收已通过。

## 固定版本

- head：`d2c3f63448130443e3e10bb5304417162f585776`
- tree：`a311b73945e9846a33a2bbd3ffa54b9e23888b1d`
- 有序 parents：own84ce、正式 batch9f142、正式 mailbox7d518、实际 UI main1c769；完整 SHA 见 index。
- 21:56:43 UTC 已正常 CAS 并回读自身 feature ref、PR body。没有移动 main 或修改其他 owner 分支。
- 本轮 CI：`42707256422/A1`；发现12条workflow。Git synthetic merge为3bc095c，但实际job checkout必须由后续原日志证明。

## 独立核对

Root及独立reader逐项比较完整6,840叶；expected/actual的path、mode、type、blob一致，missing/extra/prefix collision为0。独立reader另外重算全部874目录节点SHA1，并保存含7,713条目的完整清单。

相对b6c恰52路径＝实际UI的50＋mailbox的2；相对actualmain恰69。原own48中47个blob不变，唯一issue-workspace精确保留完整UI上游和原三项snapshotReadFetcher编辑。原Native四窗、FIRST pair1、unknown/cross-end规则及正式driver未改。

UI和mailbox分别有独立语义review；mailbox执行资格明确引用owner公开回执，没有声称本方重算未取得的原生执行报告。

## 证据边界

各历史准备和共享快照保留自己的时间、原状态；后来的publication receipt记录实际CAS，不改写原件。b6c是未发布准备对象，没有单独触发CI。旧84ce Native及CI成功不外推到本次UI源码。

11份payload共1,176,737 B，路径、字节数及SHA256见[index.json](index.json)。当前未读取本head任何原job log/ZIP；唯一reader职责已在publication receipt登记。后续CI和真实生产证据另行追加，不重跑旧测试凑绿。
