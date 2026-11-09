# 固定 5ba 的保全顺序与阶段边界

固定 source：`5ba1f9e2359ce714d83cd16fc040f2567c40a6d0`。本分析仅读源码与根侧给定的本地控制 JSON，没有读取原 R7 日志或发起新控制。

## 实际代码顺序

| 检查点 | 固定源码 | 机制与可得结论 |
| --- | --- | --- |
| 原始 baseline | [`build-template.py` L307](https://github.com/alexj11324/Mikka/blob/5ba1f9e2359ce714d83cd16fc040f2567c40a6d0/scripts/e2b/build-template.py#L307) | 在正常 bootstrap 前执行 `capture`。 |
| 严格安装保全 | [L308–310](https://github.com/alexj11324/Mikka/blob/5ba1f9e2359ce714d83cd16fc040f2567c40a6d0/scripts/e2b/build-template.py#L308) | bootstrap、npm runtime check 后执行不带 `--e2b-finalization` 的 `verify`。新增 Codex finalization 规则不改变这个严格检查。 |
| ready 保全 | [L317–321](https://github.com/alexj11324/Mikka/blob/5ba1f9e2359ce714d83cd16fc040f2567c40a6d0/scripts/e2b/build-template.py#L317) | 匿名 worker ready、身份检查和 Desktop 401 检查后，运行 finalization verify。注册的 ready 命令不是官方初始化的原子完成屏障。 |
| catalogue receipt | [L484 起、L918](https://github.com/alexj11324/Mikka/blob/5ba1f9e2359ce714d83cd16fc040f2567c40a6d0/scripts/e2b/build-template.py#L484) | 构建后先在独立 fresh sandbox 读取已有匿名 catalogue/CLI receipt。这里不是新增付费模型请求；此 sandbox 与后面的保全 sandbox 不同。 |
| fresh 保全 | [L660–677、L919](https://github.com/alexj11324/Mikka/blob/5ba1f9e2359ce714d83cd16fc040f2567c40a6d0/scripts/e2b/build-template.py#L660) | 另建 sandbox，先读严格与 ready receipt 并 validate，再执行 fresh full verify，然后 validate 新 receipt。若实际闭式诊断是 `fresh_scan`，此前的 strict/ready receipt 已通过该次校验。 |

[`official-files.py` L219–252](https://github.com/alexj11324/Mikka/blob/5ba1f9e2359ce714d83cd16fc040f2567c40a6d0/scripts/e2b/official-files.py#L219) 的普通文件 inventory 先 lstat，再打开文件求摘要，且全体条目是顺序读取；[`verify` L285–319](https://github.com/alexj11324/Mikka/blob/5ba1f9e2359ce714d83cd16fc040f2567c40a6d0/scripts/e2b/official-files.py#L285) 也逐项读回。它们不是整个文件系统的单一原子快照。并发变化可能发生在两检查点之间，甚至发生在一次普通条目的元数据/内容读取之间；后者只是源码允许的测量边界，不能作为已证故障原因。失败时不会写出成功 receipt。

## 本次控制如何影响判断

本次只有 `/opt/mikka` 定点观察器的官方控制已实际观察到 Codex 根 CA 在 pre 的 `0644` 与 ready 的 `0777` 之间变化，摘要在该步不变，fresh 又换成新摘要。它足以支持精确 root/file/mode pair 的 finalization 规则；不能据此称 Mikka 正常 installer、完整文件保全或真实订阅已通过。

Desktop 的 backup/active 两节点和四个 unit 均未变化。这不能排除其它时间区间或其它官方 writer，也不能证明某个旧 R7 的严格阶段与当前 5ba 相同。正常 bootstrap 的第三方 pnpm/pip 安装仍是实际执行边界；静态脚本没有显式 apt、update-ca-certificates 或目标路径写入，不等于证明所有传递依赖和异步官方进程无副作用。

## 若 Desktop 仍需要首次变化阶段证明

先复用唯一原件 reader 提供的实际 source/run/kind、闭式 `probe.phase` 和精确 changed-fields，不重新下载日志。若明确为 `fresh_scan`，可以先把受保护字段的首次检测区间界定为已验证的 ready receipt 到当前 fresh scan；这仍不是精确写入时刻或 writer 归因。

若现有信息还不足，最小后继诊断是在同一次正常构建既有的 capture、strict、ready、fresh 读取点，对这两个固定 APT 路径记录稳定的 kind/mode/uid/gid/size/SHA 及时间/boot ID，旁录既定四个 unit 状态；最好与实际条目读取相邻，而非只在长扫描外记录阶段标签。保留原检查、原 installer/CLI/模型路径和失败判定，不替换 baseline、不暂停 timer、不加锁、不延时等待、不覆盖官方文件，也不据 timer 时间相关性认定唯一 writer。本任务未实现或执行这项诊断。
