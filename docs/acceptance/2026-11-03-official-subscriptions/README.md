# 官方订阅 Factory 真实验收证据

本包整理于 2026-11-03，保留已有真实运行、主机核验和正常 owner 界面验收回执。本次整理没有再次登录、调用模型、连接 VM 或修改测试 fixture。**整体修复尚未完成验收。**

| 案例 | 实际工件 | execute / 独立 review / 独立 verify | 正常 owner 界面 |
| --- | --- | --- | --- |
| [Claude 首次交付](cases/claude-initial.json) | 53 bytes，Git 与实际文件摘要一致 | 三个真实 native session 均 passed | HTTP 200，已验收 |
| [Codex 首次交付](cases/codex-initial.json) | 56 bytes，Git 与实际文件摘要一致 | 三个真实 native session 均 passed | HTTP 200，已验收 |
| [Claude 续跑复验](cases/claude-continuation-82.json) | 82 bytes，保留初次 producer worktree，初次提交是当前提交祖先 | 三个真实 native session 均 passed | HTTP 200，验收 ID `4e48a083-151f-4ed4-bb94-4a461d374497` |

两种首次交付在 app / worker source `d07e4897d9578f33a7828d6fc0fda16373380a67` 上验收，worker digest 为 `1691367c6dff1cc36cde72b702bc2c8a7a31c48e`。Claude 82-byte 续跑使用 app `01c7ad23c7ab039b06b4ea482dfd7cb555e960d2` 和同一 d07 / 169 worker。每个 JSON 记录各自版本；不能把这些结果改标为后来发布的版本。

Claude 续跑的主机 proof 在点击验收前记录 task 为 approval / pending；单独的 UI receipt 和 accepted PNG 记录之后的验收。其成功证明真实文件、Git 快照、原 producer worktree 和连续 run 链，不等于证明“回答问题时恢复原 SID”的另一个未完成场景。

尚未通过的范围：

- Codex 85-byte 续跑的 producer 内容正确，但 review 失败，之后的问题仍在等待。新 release 尚未完成这一真实路径复验，不能算续跑通过。
- #1149 / #1153 的新代码或新发布不能沿用本包旧版本结果宣称实测通过；其原 SID 问题回答路径仍待实际验收。
- Claude 与 Codex 在误派仓库后自主判断、授权内切换并克隆正确仓库，两条场景均尚未真实验收。
- 本包不覆盖原离线工作区未提交改动的恢复。

[历史未完成轮次](cases/historical-incomplete-rounds.json)保留已保存的旧 continuation 失败 / 取消状态；Claude 续跑 JSON 的 producer 链也保留中间 cancelled 节点。历史失败没有被改成通过。这是选定证据快照，不是完整生产错误日志；原始文件保持不动。

## 实际界面截图

以下 PNG 均从已有截图逐字节复制，没有编辑、裁切、重绘或生成。本包未纳入包含其他 Bot 的首次 pending 截图。

- [Claude 首次已验收](screenshots/claude-initial-accepted.png)
- [Codex 首次已验收](screenshots/codex-initial-accepted.png)
- [Claude 82-byte 续跑待确认](screenshots/claude-continuation-pending.png)
- [Claude 82-byte 续跑已验收](screenshots/claude-continuation-accepted.png)

续跑截图左侧保留原任务的 53-byte 初次说明；右侧 `Current owner request` 的 82-byte 标准和对应摘要才是这次续跑的验收目标。两个时间点和不同目标没有互相替换。

## 数据范围与完整性

JSON 采用字段白名单，只保留运行 / session / candidate ID、状态、模型和 harness、官方订阅来源判断、工件 bytes / SHA256、Git / worktree 关系、版本及 UI 验收回执。没有复制 owner / connection 的私有标识、登录状态、cookie、凭据、API key 值、原始日志、聊天正文或完整工具输出。`subscription` 来源由已有主机 proof 的绑定、模型和无 API-key 指派字段交叉核对，不是从提示词自述推断。

`manifest.json` 列出除 manifest 自身外各文件的 bytes、SHA256、Git blob SHA-1 及建议仓库路径。Git blob SHA-1 使用 `SHA1("blob " + decimal_size + NUL + bytes)` 计算；manifest 不递归包含自己的摘要。后续可补充成功案例并重新生成 manifest，但不得改写这批旧运行的来源版本或结果。
