# #1284 最终生产闭环与正常停用收尾

本包保存本轮新增的生产闭环、发布追踪与自有 Profile 正常停用证据。候选字节由目录外生成的 candidate-manifest 绑定，官方 auditEvidence 的实际结果以外置审计报告为准。Git 发布和 Issue 关闭由 root 完成，本 README 不替代这些操作。

## 本次新增的实际结果

[发布收据](release/ebd.json)记录 main ebd822e9c3b8af2b6dfb0967064438642761f59b / tree0c828329a69932ade9abe678631587d238b365b9：主 CI 的12个job成功、两次Web及公网版本校验成功、官方runtime worker553c1aa18500bb63bd6a3fc0e37a69f3f48ccaf9、Daemon0.0.473。第二生产部署 dpl_12XdeeaNuun8cQXXQ5Wj9dDvp7S2 于16:00:15.590 UTC READY。Desktop pending是原收据16:01的历史观察，原件保留。[后续发布收据](release/followup-ebd.json)记录首次GitHub release API 502/500、仅失败release job原样重跑一次后attempt2成功；tag desktop-2026.10000.477的8个assets均uploaded。16:24:12.624正常公网GET仍返回ebd。

[ALEX67正常Owner验收收据](production/backend67-owner-accepted.json)记录同一Task b5785091-2c95-4f55-821d-fce51e027b0e 的实际恢复、独立审阅及接受：

- Codex Run24a6ebe7-b36b-46ec-825f-e46b5d2a2b8f以Review Profile v1、Decision/stage_fit、gpt-6-luna官方订阅/codex_cli真实运行。native succeeded，业务Review仍为failed 6/7；六项代码条件通过，未通过项是后续的Owner接受步骤。该历史结果不改写为Review全绿。
- 随后自动CC Run89f073b4-973e-4f80-88de-a75ed306d0d3使用Backend v1、Decision/capability_fit、claude-haiku-5-5官方订阅/claude_code_cli。未改源码，正常Execute Report记录baseline4/8 exit1、final8/8 exit0，native线程实际可见Bash步骤；Codex本身没有重跑这些Node测试。
- 被Review的原candidate为816513cf-503e-4ccc-b708-4bbd565206f3，最终接受的是新candidate a46be664-682b-48db-b967-1b6874275e91。两文件SHA256保持一致，两条candidate.sha均为null。Review check.sha单独记录，不冒充candidate.sha，也不声称同一个candidate UUID获接受。
- 正常Owner Accept于16:14:37.348点击，approval于16:14:39.159完成；16:14:49.449正常读回approval/passed rev20，UI Accepted和Issue Done。一次完成的Review、零Verify；三个无Run的历史blocked Review attempt不计为已执行Review。

[接受截图](captures/issue1284-owner-accepted-alex67-1793895307091.jpg)只证明可见的Accepted/Changed status to Done。长Owner备注部分不在画面内；这是授权Owner UI操作证据，不是Alex本人亲自审阅的证据。收据由root根据已读回事实整理，未导出私有Browser JSON。

生产handoff事件将本次Review Run绑定到第二Web deployment；不据此猜测全局due-timer owner execution ID。正常Owner Retry、接受备注和Accept属于授权产品写操作；没有直接生产SQL写入。

## 既有证据不重复打包

- [8641完整门禁与8图](https://github.com/alexj11324/Mikka/blob/ecd62ae1d47f32c6e01a7eb269600fbc0fdc7346/docs/acceptance/evidence/issue-1284/final-integration-8641/README.md)：各结果保留原source，不能改标为ebd。
- [生产49文件包](https://github.com/alexj11324/Mikka/blob/0acf65ab2f79ee049bf280aefca7d5d5510d3411/docs/acceptance/evidence/issue-1284/production-20261105-1436/README.md)：ALEX66、ALEX72 v1运行中冻结、ALEX73新v2选择及原收尾边界。更早的ALEX59默认路径另沿[原Issue回填](https://github.com/alexj11324/Mikka/issues/1284#issuecomment-6651675970)引用。
- [timer贡献43文件包索引](https://github.com/alexj11324/Mikka/blob/1376073af477c43a05a55ae928ed49daa82e2d7d/docs/acceptance/evidence/issue-1284/timer-contributions-89f1829/README.md)：d3/89的真实RED/GREEN、诊断与原审计；不把两轮重叠的22项合计为44独立用例。

ALEX66历史native Chrome SIGABRT与业务Review failed继续保留；独立Docker对同digest交付HTML的渲染及后续Owner接受不表示该native Chrome问题已修复。其他完整通过的独立Review案例仍按其原记录引用。

DeepSeek coding API按Alex明确要求排除，未充值、未探余额、未调用，不记pass也不阻止验收；正常官方订阅准入和既有内置Decision没有被排除。本包不要求额外模型调用，不重跑已有版本绑定门禁。

## 正常配置停用与历史冻结

[配置清理收据](production/profiles-cleanup.json)记录#1225同伴于16:20:25确认不再依赖这三个Profile后，root在16:22沿正常UI关闭三个开关：Front v2→v3、Backend v1→v2、Review v1→v2。三者enabled=false、availabilityReason=disabled、archivedAt=null；仅enabled/version/digest/updatedAt变化，未归档或删除这三个Profile。此前disabled-from-create的9192…独立生命周期案例已验证安全归档，不与本次停用混同。

16:23正常Owner GET核对四个历史Run：Front explicit v1和v2、Backend v1、Review v1的冻结版本/digest/Harness/model/订阅route保持原记录。正常UI停用是授权产品配置写入；没有直接SQL或绕过产品的配置写入，也未更改账号、订阅、模型优先级、其他Owner任务或共享原生Session。历史Task/Run保留，没有启动新的模型Run。

最终静态审计只恢复既有备份Docker的文件环境，使用保留的8641官方审计上下文，不起PG、Next、浏览器、账号lease或模型；审计前后及往返导出逐文件比对。manifest、实际audit报告和审计cleanup报告在发布时作为同目录外置元数据，原候选文件不改字节。

本轮未运行整条 pnpm test:local-loop，也未执行其DeepSeek付费分支。正常61项产品HTTP及相关CLI/PG结果保留各自执行版本，不冒称该命令已跑。
