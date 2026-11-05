# #1415 网页视觉对比证据（固定 6149 / 7973）

原完整矩阵的 98 个比较项中，97 项通过，浅色 workspace-link 超过 0.1% 门槛。该失败完整保留。定位后只补充该入口的真实机器人列表、消息摘要和 Computer 标签就绪条件；两种主题的定点复验均通过，所有四次采集均正常清理测试资源和账户租约。

## 固定环境

| 项目 | Before | After |
| --- | --- | --- |
| 产品 Git SHA | `6149eb2b75f682f1d0978af48368c5a896f315fe` | `7973afa9ad8cd3aaaaca0e5a12c05e3de8fd791d` |
| 运行地址 | `http://localhost:3002/mikka` | `http://localhost:3004/mikka` |
| 隔离数据库 | `mikka_1415_baseline_6149_r2_e2e` | `mikka_1415_candidate_7973_r2_e2e` |
| 运行形态 | 原有 Next 生产构建 | 原有 Next 生产构建 |

两侧使用独立正常绑定的环境和真实账户租约，固定相同 fixture epoch `2026-11-05T00:00:00.000Z`。采集时未更改应用源码、构建或环境绑定。

## 原完整矩阵（保留失败）

- Harness SHA256：`4a0d92d5791a04da2d8d5dd62d534b62043feab26b62a82dafa73d3eecdf1e01`，两侧一致。
- 49 个页面 × 浅色/深色：每侧 98 张原图，98 张精确像素差异图。
- 结果：97 项通过，1 项失败；原始报告仍标记 `failed`。
- 唯一失败：`light/workspace-link`，差异 `0.59868827%`，mask geometry 一致。
- 原图显示 baseline 的 Coordinator 预览、Ada 行和 Computer 标签尚未出现，而主体聊天已出现。源码确认聊天可早于独立 roster / summary 数据就绪，原检查仅等待主体消息。
- Before 和 After 的采集报告均记录 `cleanup: passed`。

## 定点复验（仅 workspace-link）

- Harness SHA256：`13d5217ad8b2f45c0f1b4ba57b8ac8de36046fa6cce2658a2fec99d3278bbdbe`，两侧一致。
- 仅追加真实可见数据就绪：Coordinator / Ada / 群的 fixture 消息摘要、Coordinator 标题和 Computer 标签。
- 未增加业务读取、固定 sleep、点击重试、mask、像素容差或产品变化。
- 两侧各 2 张原图和 2 张差异图；Before 和 After 均 `cleanup: passed`。

| 比较项 | 精确变化比例 | 0.1% 门槛 |
| --- | ---: | --- |
| light / workspace-link | 0.00540123% | 通过 |
| dark / workspace-link | 0.00478395% | 通过 |

这两份证据采用独立的版本绑定；没有覆盖原失败文件，也没有把定点复验伪装成一次新的完整 98/98 运行。

## 统一规则

真实 1440 × 900 布局，DPR 1；原始 PNG 尺寸断言；精确 RGBA 比较；门槛 0.1%。仅沿用既定的头像、时间和独立租约生成的身份文本 mask，非身份 mask 几何必须一致。每次比较均严格核对两侧相同 harness、fixture epoch、页面矩阵和 viewport。

## 完整归档

- 文件：`mikka1415-web-evidence-4a0d92-13d521.tar.gz`
- 大小：`13,111,378` bytes。
- SHA256：`c87aa67763f8ea024628f58754c1f30689bd4869b0fafa22dc8ab7398dc50ad3`。
- 总计 344 文件、300 张 PNG；其中 100 张 diff，合计 `5,101,801` bytes；所有 PNG 合计 `15,960,996` bytes。
- 内容：原完整采集和失败报告、定点复验和通过报告、两份完整的 17 文件 immutable harness、manifest，以及逐文件字节数/SHA256 索引。
- [下载完整原图、差异图及原始报告](https://chatgpt.com/library?file_id=libfile_08df638e87c481919d5eeeb93d083781&account_id=personal)。附件归 Alex 账号所有；归档 SHA256 已核对。无 session cookie、令牌、数据库密码或浏览器 profile。

后续 Linux native parity 使用同一固定候选产品 7973 和已验证的新就绪条件，作为原生托管/本地渲染器诊断；不替代 macOS 安装版和自动服务的验收。
