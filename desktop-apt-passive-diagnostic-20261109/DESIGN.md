# Desktop APT 被动定点诊断草稿

## 状态和用途

这是未激活的可选诊断包。`guest_observer.py` 的 `BOUND_CONTEXT` 固定为 `None`，默认入口返回闭式 `disabled / unbound_review_only`，不会打开 fanotify、读取目标节点或运行 systemctl。`binding.json.in` 的执行身份和时间仍为空，而且当前脚本不会自动加载这个模板。没有 workflow、host builder 修改、Git 对象、ref、云资源或模型调用。

Root 已从本次 ba1 R7 的唯一原件确认：三个模板的 strict 前后相等，三个 Template ready，唯一结构化拒绝是 Claude fresh_scan 的两条已知 CA 重链接。此前 Desktop backup 写者仍未知，但不能把这个旧未知问题变成下一次正式 R7 的新门槛。若下一次完整 R7 成功，应停止这条可选诊断并直接进行正式任务验收。

## 观察范围

仅在未来独立 guest 进程中以 `FAN_CLASS_NOTIF` 初始化一个通知组；没有任何 permission event、响应写入、mount/filesystem mark、unlimited 队列或权限干预。目录标记只指向打开并核对身份的 `/var/backups`。事件只保留该目录中 `apt.extended_states.0` 的 MODIFY、CLOSE_WRITE、MOVED_TO 和 RENAME；rename 旧/新目录项任一命中时可保留。无关目录项只解析并关闭返回的 FD，不导出其名字。

Ubuntu APT 2.4.14 的参考源码先把 active 文件 `cp -p` 到无后缀的 `apt.extended_states`，随后调用 savelog 发布 `.0`。所以 `.0` 的 close-write 不是充分的观察点，发布 `.0` 的进程也不能被称为最初写入数据的进程。本草稿始终输出 `initialDataWriter: unknown`；rename/move 角色为 `directory_entry_actor_at_read`，modify/close 角色为 `content_event_actor_at_read`。后续路径快照明确为 `later_path_read_not_bound_to_event_object`，不会把随后打开的另一个 inode 的摘要强加给旧事件。

仅额外读取这些固定对象：

- `/var/lib/apt/extended_states`、`/var/backups/apt.extended_states.0`：稳定 lstat/fstat、kind/mode/uid/gid、device/inode、size、mtime/ctime、SHA-256。
- `/usr/lib/apt/apt.systemd.daily`、`/etc/cron.daily/apt-compat`：同样的有界只读摘要，不导出源正文。
- `/run/systemd/system`：仅 lstat 存在性/是否目录。
- `apt-daily.service`、`apt-daily-upgrade.service`：ActiveState、SubState、MainPID、ExecMainStartTimestamp、ExecMainExitTimestamp、InvocationID、Result。
- 两个对应 timer：只读取 LastTriggerUSec。
- kernel release、boot ID、观察段/实例 nonce、ACK challenge 和受保护进程身份的固定 proc 元数据。

没有 env、cmdline、cgroup、任意路径参数、目录遍历或全盘扫描。exe 使用一次 `O_PATH` 对象引用，只记录读取时的元数据；已知系统命令路径来自闭集，其余路径只给长度和 SHA-256，不导出任意路径正文，也不读取可执行文件内容。

## 进程与事件证据边界

解析器采用 Linux v6.6 的固定 amd64 UAPI：24 字节 metadata、4 字节 info header，遍历所有变长 info 记录，完全不依赖 PIDFD/FID 的顺序。名称只能是有 NUL 终止的有界 basename，句柄和事件长度均有上限。未知版本、未知 info、重复记录、长度越界或非法 padding 会使该观察段 incomplete；不会猜测偏移继续解析。overflow 在任何文件名过滤之前处理。

PIDFD 必须有效且活跃，fdinfo 的 PID 必须与事件 PID 一致。读取 exe 前后核对 starttime，并再次检查 PIDFD 活性和 PID。缺失、退出、复用、权限拒绝或中途变化都只输出 unknown，且不保留先前取得的 exe 内容。一个有效 PIDFD 也不会冻结 exec：字段特意叫 `exeAtRead`，`exeAtEvent` 仍是 unknown。短命的 cp/mv 在队列读取前已结束时，无法事后靠裸 PID 补身份。

所有已识别的有效 event FD/PIDFD 都关闭，包括非目标事件和解析错误前发现的 FD；负 PIDFD 不关闭。解析错误会结束专用观察进程，进程退出负责释放无法安全遍历的剩余内核返回 FD。因此运行时必须是独立短命 observer，不能把 `run_bound` 嵌入长期存活的应用进程后继续复用它。

事件可合并，CLOSE_WRITE 不保证字节变化，mmap 等写入方式不是这组通知的完整覆盖范围。0 events 从不被解释为没有写入。日志时间是生成观察记录的时间，不是内核写 syscall 的时间；它不提供精确写入时间戳。

## 预算和生命周期

- 单次内核读取最多 64 KiB、512 个 event、每个 event 至多 16 个 info；handle 至多 128 B，name 至多 255 B。
- 一个观察段最多记录 256 个目标事件；每记录最多 32 KiB，JSONL 总量最多 1 MiB，并为 terminal 留 32 KiB。
- 固定文件每次最多读取 2 MiB，使用 O_NOFOLLOW 和读取前后的身份校验；变化、缺失、特殊类型、超限或读取截止均输出明确状态。
- 四个 systemctl 命令均为固定只读 `show`，输出各至多 4 KiB，每次最多 250 ms；只清理 observer 自己创建的该 systemctl 子进程，绝不停止 APT unit/timer。
- 观察段的正常工作上限 600 秒，绑定的绝对窗口最多 900 秒。代码以事件/请求驱动，没有 sleep、重试轮询或人工采样延时。IPC/只读命令有正常的有界 I/O 等待，不用于等待 APT 自行发生变化。
- 所有持久输出和控制 socket 都在 `/opt/mikka/issue1505-apt-observer/<segmentNonce>/`，新目录/文件禁止覆盖，目录 0700、输出 0600。

开始时只有 fanotify_mark 成功且目录身份一致才写 mark ACK。活性验证使用一次新的随机 challenge 与本观察段 Unix socket 往返；旧磁盘 ACK 不是活性证据。不存在自动重启后拼接旧覆盖的逻辑。boot/目录身份变化、unknown actor、溢出、中断、格式错误或输出上限会保留 incomplete；结束请求不会冻结 writer，所以 stop 队列边界也明确记为未证明。`coverageAcrossCommandsOrBoots` 始终是 unknown，这个草稿不声称已经验证 E2B 的后台进程/内核 mark 能跨 layer、run_cmd 或 snapshot 存活。

## 正常 5ba 流程的接线位置——仅设计，未实现

原 `scripts/e2b/build-template.py` 必须继续执行原来的独立步骤：capture → 原 bootstrap → NPM runtime check → strict verify → 原 start/ready → 原 catalogue receipt probe → 原 fresh conservation probe。不能合并 run_cmd、提前跳过 strict、替换 baseline、关 timer 或用这份诊断代替任何正式验证。

如果将来确实需要使用此草稿，root 可以在这些现成边界增加独立的定点 checkpoint，但必须先完成以下接口核实：

1. 实际 guest kernel、amd64 libc ABI、文件系统句柄、PIDFD 和权限是否支持所选 flags；UID 0 本身不能证明能力。失败直接 unknown，不静默改为弱身份方案。
2. 精确目录的 name_to_handle_at/fstatfs 绑定与实际 fanotify DFID_NAME 是否一致；此 ABI 组合未在 guest 上运行过。
3. 专用 observer、fanotify group 和 Unix SOCK_SEQPACKET 是否能在原 run_cmd 结束后仍存活；跨边界必须重新使用 fresh challenge，而不是读旧 JSON。
4. ready/fresh 是否换 boot 或实例，以及官方初始化发生时 observer 是否已经启动。启动前或恢复间隙永远保留 unknown，不能把两端快照拼成无缝覆盖。
5. finally 能否保留诊断并精确停止本 observer，且完全保留原命令退出码、原严格检查和资源清理。未来还须由外层拥有者提供执行环境的硬终点；本地离线测试不能证明内核/文件系统调用不会阻塞。

这些接口未知项是草稿的使用条件说明，不是当前 R7 的新增 gate。没有提供任何自动启用或云执行路径。

## 已执行的离线验证

实际命令为 `python -B guest_observer_test.py`，Python 3.12.14，21 项全部通过。完整 stdout、stderr、源哈希与运行命令在 `validation/parser-01.*`。

测试只使用合成二进制事件、假的 PIDFD/proc 访问器、假的 ACK 以及 scratch 临时 journal 大小上限。覆盖截断、长度/版本、record 顺序、handle/name 越界、rename 发布语义、非目标 FD 清理、无名 overflow、负 PIDFD、退出/复用 PID、fresh challenge/boot/实例不匹配、输出上限和默认 disabled。没有调用 fanotify、真实 proc 身份解析、systemctl、网络、E2B、模型或产品保全测试。21 项绿色只证明这些离线分支，不是 guest 能力、writer 归因、全文件保全或发布通过。
