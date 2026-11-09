# A024 诊断窗口候选：离线禁用，禁止发布

本目录是固定 A024 源码的审阅材料，未创建任何 Git 对象、分支、scope、Web dispatch 或正式任务。根代理随后报告 runtime 42566225093/2 因 desktop ffmpeg-static@5.3.0 LICENSE 下载 HTTP 504 失败；订阅和发布均未执行。本候选保持禁用。后续实际 source 变化时，必须重新绑定 source/tree、复核五项合同与所有实际发布元组，不能直接启用这里的 A024 草稿。

## 审阅入口

- issue1505-diagnostic-window.mjs.review：原 helper 仅改 SOURCE、TREE、BRANCH、GO 四个比较字面量。
- issue1505-diagnostic-window.yml.review：完整 job 为 if: false，两个执行 GO 为空，dispatch pins 的 enabled 为 false，pins.go 与 helper.go 为空。
- candidate.diff：相对 f997 的两文件完整差异；source-index.json 提供固定 Git 原件重建指针。
- dispatch-pins.disabled.json、plan.json：列出 18 个 future null 字段及完整动作顺序。协调审阅布尔为 false，comments 为空。
- formal-renderer/：原 evidence commit 的 renderer/template 按原字节保留；partial pins 只填拟用的 A024 driver/source/tree、APP 和未来分支。原模板仍禁用，完整 formal workflow 尚未渲染。

## 最终父链必须保持

最终 enabled H 必须是 5958dea38437de20512bbbdf60b940ccc83f00ff 的直接唯一子提交，父树为 af895d6418b1b1d960b2884aec91a2078bb37d96，仅变更原 helper/workflow 两条路径。它与 f997 是 sibling。不要先 push disabled commit 再追加 enable child，否则 helper_parent_not_pinned；也不要把 parent 改为 f997，因为 readPreviousWindow 还要求历史 receipt.workflowHead 等于 HELPER_PARENT。父树和嵌入的旧 receipt 均未修改。

## 原 renew 的 absent 路径

继续使用原 renew 入口。它先核精确历史 e33 receipt；若首 env list 无同 key/id 项，不发 DELETE，但仍必须 exact old ID 返回 404，末次 list 同 key/id 均 absent，才能写删除回执。出现相同 key 的不同 ID、重复项或 value hash 不同仍拒绝。之后正常 prepare 创建新的 now + 120 分钟 scope，不沿用历史 TTL。历史 e33/5U3 receipt 与后来 bb5 cleanup 42531083519 是两份不同事实；本准备没有查询当前生产 env，也没有把后者改称前者的回执。

## 授权和时序边界

保留原 SMOKE_OWNER、shared workspace hash a38307f75620de4bfe3b374ed2d510041da807af094c571eafb0318ce21f3535 和 Bot fdeea45f-8cb2-450a-96a4-d9a682f71482。不新增 GitHub credential 读取、刷新或轮换；沿用已存在的只读连接，不替换账号、Bot 或工作区。

正式开启前，root 必须先有新的实际 R 全 7 jobs、发布及 cleanup，以及可核的 Web/DPL/source 元组，并重新确认有界协调窗口。继承组合中的 operator R 检查在 scope prepare 之后，因此“R 已完整发布才建 scope”是 root 激活前置，不能冒称已有更早的 workflow 内门槛。

原顺序为 scope/rotation artifact → 原 operator 全部校验 → 保存 intent → 唯一标准 Web workflow_dispatch → 保存精确 returned child ID/response artifact → 自身 ref 清理。未知 dispatch 结果不重试、不搜索猜 child。root 在实际 child READY/source/public version 回读后才填写正式元组。scope TTL 120 分钟；formal 入口剩余至少 45 分钟；这不是 child token 的 45 分钟源码门槛，token 仍需按真实 expiry 覆盖全过程判断。

当前发布段 05:14:35–06:14:35（root 引述 comment 6732811394）没有作为授权复制到候选 pins。正式 45 分钟段尚未登记，须包含 fresh scope、唯一 Web refresh、完整六例和 cleanup；本文件不延长当前发布段。

## 已做的必要离线检查

helper 和原 inline operator 的 Node 语法、三个 Bash block 的 bash -n、ref cleanup Python 和 renderer Python 语法均通过。helper 四字面量逆变换恢复原字节；workflow 除明确 pins/header/disabled 字段与原 source 常量替换外，逆变换恢复原字节；31,102 B operator 完全未变。五项 source 合同与 f997 的 pins 逐 blob/SHA 一致。原 renderer 的 template_from_base 结果相同；未填 pins 按原规则拒绝于 pin_unfilled:EXPECTED_WORKER_SHA。

没有重复 operator 全套测试，没有安装依赖、执行产品入口或模型，没有生产/env/SQL 请求。未安装 YAML parser，因此不声称执行完整 YAML 解析；仅已知结构的局部替换和实际提取块检查。checks.json 是检查原件。

旧正式六例的 FAIL 结论及新正式样本为 0 的界线不变。本目录不证明新 R 发布成功、当前速度或 5 秒达标。
