# CP46：生产前的精确边界与原件入口

本 checkpoint 只归档只读核验；没有提交生产任务、改账号、改应用源码、重读原 job log/ZIP或创建运行资源。正式生产仍0/2。

## e093→84ce Native真实差账

完整Web427→427；完整Native451→426；FIRST Native205→198，Hosted207→228。四窗、12checkpoint、8segment全部守恒，errors=[]。所有unknown和原边界保留。

完整Native净−25精确为：bots.pollBots34→8(−26)、chat93→92(−1)、issues22→21(−1)、unknown91→94(+3)；其余粗context相同。四个bot调用[2,2,28,2]→[2,2,2,2]，新原件没有额外Personal probe。原26条额外SQL保留18known/8unknown；不把未知参数或rowCount猜成已知。

所以新预算426≤427是真实通过，但不是Native直接实测空回填26→1。后者由CP43真实PG独立RED/GREEN证明。两次API启动年龄不同，实际缓存时间没有记录，不能把时序推断升级为cache命中事实。FIRST Native−7/Hosted+21也不说成28条Native优化。

旧Hosted chat跨原end227ms保留；新所有crossEnd0。physical/logical16/41→14/40，所有40具名logical调用数量保持，少了旧null-action401和一个独立chat HTTP转入batch。详见完整不可变diff。

## 执行合同

固定workflow ebbf83b8、driver10407557、browser2f6cb3ab、wrapper51582624和ops transport7429381c的字节/hash与字段表保存在执行索引。

下一次dispatch必须用fresh requestId和当时actual main/served full SHA，不能复用ops里历史controlled-failure/1d126请求。最小顺序为preflight/all/prepare=false/browser=false，然后独立Claude和Codex execute/browser=true单case，prepare按实际预检决定。每case一次真实UI提交；成功runtime只证明应用/清理，不冒充PostHog/Replay通过。

artifact名run-trace-acceptance-RUN。正常preflight为report/recovery两JSON；正式浏览器case还应有browser-actor.receipt.json。always upload成功不证明这些文件齐全。

实际task/issue/runs[].runId/workflowRunIds及browser.replay.sessionId取自实际JSON；browser模式没有直接traceId/requestTrace，使用既有14条PostHog冻结查询按实际ID查找。不混淆Factory task UUID与carrier issue ID、应用wrun与GitHubrun。

原日志不会打印完整JSON或实际run/task ID。固定源码支持在准确绑定source/inputs、总体和单模型runtime_verified、实际执行step完整SUCCESS且job自然终态、artifact上传已完成之后，暂以退出状态支持“代码已通过清理检查”的推断。不得把该推断写成已读cleanup字段；最终仍核原三JSON。失败、超时、不确定点击、清理不完整均停止下一case，不重发来凑绿。

所有三JSON与正式export原件原则上由Root作为唯一原reader提取，各ZIP一次；其他审阅者复用Git原件。必要时用短命取证VM，读完即清理。实际分配/运行与费用此刻均未发生。

## 收尾

源级case cleanup、全局preparation/session恢复、browser登出匿名回读和关闭、provider机器结束、ops ref关闭各自核实。ops cleanup须正常提交指定前缀且触及watched path；只删自有source-objects和git-transport两refs，不替代业务清理，也不等同取消runningjob。待证据持久和所有owned操作结束才执行。

## 当前共享事实

21:01:55–21:02:48快照main仍12458，仅前一两README变化。其R7 build成功、await-web中，Web production上传；尚无新runtime发布。#1505明确child未撤销、实际窗口未release，新正式六例0。原owner三候选已deleted/sandboxes[]/errors[]的安全投影不等于child撤销。

#1839 exact205d26d仅改三份Codex源码/测试，是允许普通branchmerge的固定依赖，尚未合并；#1836仍原ed60885/14paths。#1840为两个README未来修改，仍open，不是hold。兼容0.167修复head在此有限快照尚未看到，不断言不存在未发表代码。

CP45已普通发布4bd0cfff，PR1799于21:00:54改为当前84ce通过/生产待验，issue1512进度6751352913于21:01:11发表并读回。当前PR正文快照和发布证明随本checkpoint保存；旧正文仍在CP45。
