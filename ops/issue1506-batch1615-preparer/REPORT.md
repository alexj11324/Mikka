# Batch1615 禁用验收准备器 V2

## 结论

本版解决 0d 新 live 源码与旧验收加载器/worker 的两个实际不兼容点；未改产品、UI、远端分支或验收控制。默认仍完全禁用。输出明确为 **11 路径、12 来源 pin**，不冒称原八路径不变。

固定审核输入是 `0d379dd92fd2d7b3f2b307030c3bcd8234426d0e` / tree `c7efece9d5a2f9e5fb4d01536daaf18d3bdcd97d`；0d 是 83、ad224、a65 后继。实际未来 merged SHA 尚未作为生产输入执行。离线预览的 `notActualMergedOrDeployedApplication=true`，预测 acceptance tree 为 `e7871f5edaed80ca895fdd0a8882d8023bcc0e70`，不是生产或已发布状态。

## 源码增量与复用边界

原十个 live pin 中只有 channel.ts 与 use-live-key.tsx 相对83变化；另外八项及 decoder 490572…逐字相同。新 channel 导入真实 read-observer，刷新新增 after 同realm顺序屏障，并保留当前活跃消费者及更高已知revision。hook 用 readFresh 复用在屏障后启动且实际提交到缓存的读取，保留 required/held/local revision、namespace、local-write identity 与生命周期守卫。

新增 read-observer.ts 的 readBoundary 是单个 realm 内递增顺序，**不是时间戳**；不能跨worker或跨时钟相减。observeSWRRead 只在实际 onSuccess 接受且同一对象已进入缓存后确认 committed，discarded/failed 不构成新鲜性证据。components/swr-defaults.tsx 的实际接线也固定为 provenance；不在 CLI 渲染 React。

群合约31项相对83有3项不同：group-turns.ts 与 lib/db/schema.ts 为已审0c失败元数据；相对已审465仅 group-runtime.ts 新增 withAiMetadata(operation bot/coordinator) 包裹原调用。窄读该函数仅以 OTel context.with 调用原 work，未改本段模型选择、AbortSignal、streamFailure/错误恢复或group-terminal位置。不能将源码兼容称为新生产群停止通过。全部字节矩阵在 compatibility-source-proof.json。

## 两处验收接线

1. live-source.mjs 固定十二项，允许相对导入仅解析到该表内的 .ts 运行时模块；外部包、未知目标、越界目标、TSX均拒绝。源文件原算法未改，仅转换TypeScript及导入后缀。

2. live-worker.mjs 的 refresh 消费真实第四参 after/readFresh。正常 RPC read 由真实 observeSWRRead 包裹，promise continuation 依实际顺序 acceptSWRRead→storeSnapshot，同一对象提交后由源码自己的微任务确认。原所有 scope/revision/local-write/close 边界保留。lifted readSnapshot 仍是同一正常RPC读；fixture-read仅在测试平台模块接收，生产worker没有此控制消息/flag。

readFresh、readBoundary 等来自同一个编译模块URL，因此一个worker内的channel和read adapter共享同一个顺序计数；三个worker保持独立堆、缓存和socket。对React/SWR自身的完整调度、渲染或hydration不作新的运行时通过声明。

## 验证与原失败

- 首次 fixture 缺少 unchanged decoder 导致 ERR_MODULE_NOT_FOUND：保留原 source-loader-red.log/json，另有 setup-failure 分类；**不计合法RED**。随后只补入 SHA490572…的真实decoder。
- 原加载器 + 新十二源：实际 RED，live_source_import_invalid；见 source-loader-actual-red.log。
- 保留fcce refresh语义、仅把既有RPC读提取为可被离线平台独立调用的函数：实际 worker 在真实push后已有在途读取时仍多读，RED为 **2 !== 1**。新源码与相对导入解析在此两侧一致；不是导入失败或假模型结果。
- 完整 live-consumer.test.mjs **18/18 GREEN，0skip/0cancel**：原三worker共享一次读取、旧响应拒绝、早到push/真实关闭，新增同realm after复用/before不得复用/later revision不丢以及依赖白名单。
- 内容review基准最后改为0d，只有来源字段变化；定向真实源码编译/导入 **1/1 GREEN**，不重复行为套件。
- 准备器 **9/9 GREEN**：真实Git对象、11路径/19保护对象、四checkpoint字节不变、未知pin/新增源/decoder漂移拒绝、额外worker篡改拒绝、激活/legacy变动拒绝。没有重复普通Stop14或全仓测试。

所有命令/exit/hash在 logs/；网络在夹具中禁用，无模型、认证、生产SQL或发布。

## 禁用与下一阶段

base为 fcce5474… / bbb6791…；四个普通Stop/工具修正仍来自344faf checkpoint，字节完全不变。continue.json不在overlay内，仍enabled=false、phase=tool、expectedSha=null、cacheTurns=3，workflow仍during_tool。presence literalfalse/空SHA、MCP literalfalse/空SHA/12分钟、legacy resume以及19保护对象全部保留。

只有root今后另外明确激活，才选择phase=cache-live。它把observer注入同一个runCacheTurns，原Haiku3+Luna3最多6次send，没有额外模型消息。warm固定H2/H3/L2/L3≤3000ms，原失败/未发分母不变；两个模型独立session/wrapper继续保留。observer只代理正常ticket/chat，chat上限24、3socket/worker清理及coverage deadline原样，未加轮询或新生产查询预算。新cache/live取证可以共用同六条自然消息；当前零发送。

## 输出与未来漂移

精确11paths与SHA见 frozen-manifest.json / prepared/offline-preview-0d.json，12pin旧→新见 source-pin-matrix.json。新模块依赖检查、已审漂移introducer与0d祖先检查全部必须通过。未来actualhead若只改变测试/ops，可依真实blob逐项复核复用；db988或其它channel变化会拒绝，不能静默接纳。

准备入口（当前**未用于实际merged/deployed输入**）：

```sh
python3 prepared/prepare.py --repo /vercel/Mikka --application-sha <actualMergedSha> --application-tree <actualTree> --output /vercel/recovery/disabled-preparer-batch1615/prepared/actual-<unique>
```

本报告和预览均没有赋予远端写入、生产激活或追加模型/SQL权限。
