# 官方 Desktop 480 秒延时对照（#1506，2026-11-09）

本记录供发布负责人复核 Desktop 原文件保全失败的排查证据。**结果为阴性：本次延长等待没有复现 APT 备份变化。** 这是一项官方空白模板的定点观察；没有执行 Mikka bootstrap、模型调用或发布，也没有完成真实安装的全盘保全验收。

## 运行与原件

- 运行：[42621745896，attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42621745896)，2026-11-09 13:10:29 UTC 终态 SUCCESS。
- 操作源码：`50c4591991b599af4a2ba9680d1433656dd00077`；固定产品源码：`e78fccffd9dd878edd490b113ea80efcff1525e7`。
- 资源范围：一个官方 Desktop 派生私有模板、一个 fresh 实例；工作预算 600 秒、绝对窗口 900 秒，未扩大原清理边界。
- Artifact：`13676493857`。配套 [JSON 原件](1506-official-desktop-time-extension-20261109.json) 是已核验 EXPORT 的逐字节副本，含 `desktop.json`、`summary.json` 的完整闭集观测和清理记录。

原件绑定如下：

| 原件 | 字节数 | SHA-256 |
|---|---:|---|
| 配套 JSON / EXPORT | 21,204 | `54c93f35323a2f4b116d651c71148ac02f3cd425d9044f803c55c158c632d8df` |
| Artifact ZIP | 2,434 | `caa413374f6d6f20900a729b4bd4666e1f7ff249e406060be8b2a7abe63f1930` |
| Job `129175370925` 原日志 | 383,300 | `ea03483f1a75fc819e9fbbe9d7ff9409eb25947afd661492b5fe94ca62fc89bc` |

## 实际观察

构建期间执行两次 240 秒等待，并在中间增加一次定点读取。单调时钟只能在相同 boot 内比较：

| 阶段 | boot ID | 单调时钟（秒） |
|---|---|---:|
| `before` | `fe73e011-8a62-4b7a-a934-cb395412e500` | 27.767622525 |
| `after_240s` | 同上 | 271.742720053 |
| `pre_finalization` | 同上 | 512.478671551 |
| `ready` | `8d57e1e0-92d3-4121-ae62-8e9ff64fcadb` | 2.080349589 |
| `fresh` | 同上 | 16.642199210 |

`before` 到 `pre_finalization` 的同 boot 观测跨度为 **484.711049026 秒**。`ready` 与 `fresh` 属于另一个 boot，不与前一 boot 做时钟相减。

五个阶段的四个目标节点元数据以及 APT 状态记录完全一致：

- `/var/lib/apt/extended_states`：SHA-256 `da850c564cb1797d4ccea654530605994986e9a81497d9f47fa8497504e89347`。
- `/var/backups/apt.extended_states.0`：SHA-256 `52f87bdad074b319ed8b601e4c5e97ab0d5ce235bafac3213d32f1873f7413ac`。
- `/var/backups`：记录的目录类型、权限、归属、inode 和时间元数据均未变。
- `/usr/lib/apt/apt.systemd.daily`：SHA-256 `4949c220a844071ee4709115aadfc00684578d5c7dda9c1b5a5c65a75de9d50f`；APT 版本为 `2.4.14`。

两项 APT service 的定点记录均为 `inactive/dead`、`MainPID=0`、开始和退出时间 `n/a`、InvocationID 为空。两项 timer 的最近触发记录分别固定在 2026-11-02 与 2026-10-06，没有本段新增触发记录。这些点采样没有识别出原失败的写入者，不能作为系统中从未发生其他写入活动的证明。

## 清理与入口

清理 receipt 为 `complete`，`errors=[]`：实例 `i0vo7375dc7nxy4rp6tyq` 已按精确 ID 确认不存在，私有模板 `pfvqierzqzbmuvomcleh` 为 `absent`。资源身份、run、attempt 和操作提交均保留在配套 JSON 中。

诊断入口已通过普通快进关闭提交 [`62c686b9d3a96b25d68ca2829c44af00e49f544b`](https://github.com/alexj11324/Mikka/commit/62c686b9d3a96b25d68ca2829c44af00e49f544b) 停用。该关闭提交关联运行的终态由发布负责人另行记录，本记录不为其补写通过结论。

## 结论边界与后续操作

这次结果说明：在本次官方 Desktop 实例中，延长纯等待到上述观测跨度仍未复现备份变化。它不等价于原全盘 capture、安装子进程、NPM 检查和 strict verify 的负载，也没有排除原构建分层或其他并发活动。原失败的实际写入者仍未确定。

本证据不增加 APT 或 `/var/backups` 例外，不加入持锁、关闭 timer 或改写原文件的修复。`targetedOnly=true`、`releaseAccepted=false`、`policyChanged=false` 保持原值；SUCCESS 表示这次观察和清理完成。

下一次实际正式构建继续执行[原 strict 全盘保全检查](https://github.com/alexj11324/Mikka/blob/e78fccffd9dd878edd490b113ea80efcff1525e7/scripts/e2b/official-files.py)。若相同文件具体复发，再沿该次 capture、bootstrap/NPM、strict verify 与 ready/fresh 的实际阶段保存定点身份、时钟和文件元数据，定位真实变化窗口。本结果不支持第三次仅延长等待的盲目重试。
