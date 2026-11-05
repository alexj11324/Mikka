# UI6：主线 #1457 与 Owner 同候选复核的独立复核

## 结论

**通过本轮界面入口与动作呈现复核；没有发现严重度 3/4 的阻断。** reviewer `prepare_final_ui_increment` 已逐张打开全部六张原尺寸 PNG，每次仅查看一至两张。reviewer 准备了外置截图脚本，没有实现或修改产品 UI；本记录来自实际下载的图片、metadata 和运行日志。

重点 approval 面板在同一首屏内完整显示：上方的次级 **“重新审阅”** 与后果说明，底部同一行的 **“退回修改”** 和黑色主按钮 **“验收”**。实际按钮文案是“验收”，不能在证据中改写成“通过”。三项操作没有挤压、重叠、裁切或横向溢出，新增拒绝操作没有遮挡已有复核入口。

## 逐图观察

| 原图 | 实际观察 |
| --- | --- |
| `waiting-light-390-entry.png` | 任务标题、Factory 验收卡片、等待回答标签和进入箭头完整可见；摘要换行正常，没有覆盖状态或箭头。 |
| `waiting-light-390-pane.png` | 独立审阅建议合并、验证进行中保持可辨；底部说明和“重新审阅”完整可见。顶栏此帧显示既有通用“线程”。 |
| `approval-light-390-entry.png` | “待你确认”状态与入口清楚，原英文摘要按既有方式截断，未覆盖入口动作。 |
| `approval-light-390-pane.png` | 验收标准 1/1、报告入口、独立审阅/验证结果完整；“重新审阅”位于说明下方，底部“退回修改”和“验收”并列且层级明确，三个动作均在 844px 视口内。 |
| `expired-light-390-entry.png` | 过期夹具仍有正常 Factory 验收入口；标题描述过期场景，实际状态标签保持等待回答。 |
| `expired-light-390-pane.png` | 重新审阅和说明完整；未把验证进行中显示成已通过。顶栏仍为通用“线程”，没有出现新的按钮遮挡。 |

## 与上一轮 UI5 的具体差异

对六组同名 PNG 独立计算 SHA256 并逐项比较：**除 `approval-light-390-pane.png` 外，另外五张与 UI5 逐字节相同。** approval 面板的可见变化是底部增加“退回修改”；原有“重新审阅”和“验收”保持可见。

waiting / expired 的通用“线程”标题与旧截图的异步标题限制一致。过期场景仍使用原等待状态文案，标题中的“已过期”来自合成夹具。这些静态图没有证明新的过期专属状态提示，也没有证明标题在后续时刻仍不加载。

本轮截图只覆盖正常加载后的入口和面板。没有点击重新审阅、退回修改或验收；没有把静态截图当作 POST、错误恢复、键盘操作或生产模型验收的完成证明。深色与桌面维度仍对应先前明确绑定版本的 18 图，不改写为本轮重新截图。

## 来源、尺寸与完整性

| 项目 | 实际记录 |
| --- | --- |
| 本轮源码 HEAD | `3f0daaf76f7c1da346275585bde806a3abd5a8ee` |
| 本轮 source tree | `277259bbe1cb177abc6bf9866dffabf64fe51e0f` |
| BUILD_ID | `vrJIGEXahx3S4XQF7Ao5C`；与实际 `build-id.txt` 一致 |
| Chrome | `157.0.8103.38` |
| origin | `http://localhost:3107` |
| 截图时间 UTC | waiting `22:44:37.482`；approval `22:44:39.300`；expired `22:44:40.948`，均为 2026-11-05 |
| PNG 尺寸 | 六张均为 390×844 |
| 页面宽度 | 三组均 viewport=390、pageWidth=390；目检同样没有横向溢出 |
| 图片清单 | 六个 PNG 和两个 metadata 文件均重新计算 SHA256，与 `files.json` 一致 |
| 证据审计 | fixture 与一份 runner 扫描均 `passed`，扫描对象各为六图及 `review.json` 七文件 |
| UI 包 | 九文件，258,976 bytes；SHA256 `9e8793930f6ae86e26fbb293c6f26695d509a3683d82c187b18845417a6802b6`，独立重算相符 |
| 原始日志包 | 33 文件；包与每个文件的 SHA256 均独立核对，包 SHA256 `daa256a08a136f70a8fa5b5f4bd357cbde29cc24e6abc8eb0fff7f1120df9749` |

这是实际 checkout 的版本记录。root 发布的等树远端 source commit 的身份由其 Git 对象读回另行对应，不把本轮运行写成发生在另一个 commit 上。

## 实际测试与构建

直接读取 `acceptance-ui.log` 的 spec reporter 末尾 `ℹ` 统计：

| tests | pass | fail | cancelled | skipped | todo | duration_ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 134 | 134 | 0 | 0 | 0 | 0 | 2128.756652 |

这些是当前九个文件的源/Happy DOM 检查，不是 PostgreSQL 用例计数。通过的实际项目包括：仅存在拒绝 handler 时显示“退回修改”、同候选重审要求 capability/detail/ledger 精确匹配、旧版本或普通 Artifact 不出现验收控件、候选/revision/evidence 一致后才可操作，以及真实 Artifact 容器的决策区呈现。

`flow-view.test.ts` 明确**未在本轮重新运行**：`stages.log` 记录 `flow-view not-run; unchanged source file, prior run retained at 925245`。之前的 7/7 保持绑定 `925245…`。

`typegen`、`typecheck`、UI6 setup/bootstrap、build、capture、audit、package 的阶段日志均 exit 0。实际过程 `processes/proc-1793918511021397480-18` 为 exited / exitCode 0，脚本时间 **2026-11-05 22:41:51–22:44:41 UTC**，整体 `result.txt` 为 `exit=0`。

默认 `pnpm exec next build` 的资源原件记录：

- UTC `22:42:08.728098` → `22:44:26.264353`，**137.536398419 秒，exit 0**。
- 最大子进程 RSS **10,157,500 KiB**，这是子进程最大值，不是整机总占用。
- OOM kill 计数 **0 → 0**。

正常租约账户的 sign-up、get-session、workspace、Coordinator read 与 `/mikka` landing 全部 HTTP 200；三个 Owner task GET 也均 HTTP 200。诊断只记录路径/方法/状态。

源码前后 diff 日志为空且阶段到达 `complete`；脚本的 exact HEAD/tree 检查通过。UI6 自身数据库清理没有错误输出，PostgreSQL 日志明确 `server stopped`。本记录不据此宣称整台 Large 已停止或删除，平台生命周期由 root 单独读回。
