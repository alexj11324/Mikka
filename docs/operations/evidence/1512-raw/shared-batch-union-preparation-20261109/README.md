# CP48：共享修复批次与本方合流树的实际核对

本 checkpoint 没有发表新 feature commit/ref、触发新 CI或提交生产案例。本方正式源仍84ce，生产验收0/2，自有VM/PG资源0。新准备的是未发表合流树，不借旧CI认证新组合。

## 固定依赖和批次

#1836 ed60885d、#1839 205d26db、#1842 98a0db9e的实际source与owner普通branchmerge授权已记录。#1842生产代码只精确增加匿名0.167.0资格；未知、patch和prerelease拒绝。#1839增加MCP required。两个重叠文件按任一顺序应用均逐字相同，全部既有保护和断言保留。

owner给出的实际批次tree50f85fb5c687ec19c3e0c06d96e189fb6b18e62b相对main12458有19paths。Root逐项对齐#1836的14原blob和另外5文件；独立reviewer对两处组合全文核SHA，全部一致。此前published batch commit/head仍未观测，因此三parents此刻只作为owner声明记录。

#1836与本方共同基线5ba1f9e→两端的84/14paths零交集；本方相对main7848净48项亦零交集。84不是本方净改动数量。saved-binding懒catalog、生产WORKFLOW_EVENTS_TRANSPORT=http和transport计时均为真实变更，不称纯日志。firstByteMs为HTTP响应头首字节，不当TTFT，offset也不相加成互斥阶段。

## Root准备的合流树

以本方84ce/tree e7c7为底，保留全部48项自有净变更；纳入共享批次相对共同main7848的21项（19项修复+2README）。交集和路径前缀冲突均0。

准备结果tree **84e5abc87cd5fcd3d6c9459d3e9ff1e6a2dde058**，远端 **6822个leaf逐path/mode/type/blob核对，0差异**。driver104075、browser2f6、workflowebbf、driver-test2e3、coordinator d73e、PGtests c6c均原字节保留；全部原Native合同仍在自有48项保留集合中。packages子树与共享批次完全相同，patches也相同。

当前只创建了这棵reviewable source tree；没有创建或发表feature merge commit。待owner正式发布batch head且其tree/parents与已审身份相符，再以正常merge parent绑定；若源码变动，重核实际差异。

#1836/#1839/#1842确实改变canonical daemon输入，不能沿用旧84ce与旧main输入相同的结论。未计算W，未认证新runtime，也未增加AppSHA=RuntimeSHA条件。mailbox native-resume 0.167两文件尚未发表，未纳入这19paths。

## 历史受控失败/开销适用性

#1836的14paths与CP43的20探针依赖交集0；20项本方blob都等于原回执after。RunSampler/RetainingSpanProcessor/SafeExporter/StageLog/SafeLog/PGhooks/probe未改；原serverless drain和sanitizer范围判断不变。没有因此无故重跑相同probe。

历史值仍只属于原Web/loopback/memory-exporter场景，不覆盖新HTTP/model附加日志、daemon或网络成本。原测量准确描述为**每条件600次、每条件100预热、20请求一组交替；不是逐请求随机配对**。

初始1836 review把该叙述误写paired，旧a8af保留为superseded-wording。替代4ee285只更正historicalScope并增加supersedesBlob；Root逐结构核对其余全部字段/source hashes不变，无新实测。

## 当前共享终态

21:26:11快照：main仍12458，Web成功；R7 42695935772实际FAILURE，subscriptions失败、publish跳过、cleanup成功。owner本轮安全投影为execution_failed/startup_ended_before_execution_proof，不能归因成上次adoptionmissing或README改动。

#1505的child清理实际子窗口为21:24:11开始、最迟21:29:11进入、hard end21:39:11；此快照没有release。旧清理入口前置guard失败，OIDC/撤销跳过；R7候选清理不替代child撤销。原log/ZIP均未由本方重读。
