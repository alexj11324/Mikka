# Coordinator 后续验收：禁用准备稿（恢复版）

本稿由新的离线恢复准备器生成。旧执行环境不可用，不能将本稿或新四文件哈希冒充旧准备器的字节恢复。
本稿没有执行生产登录、模型、SQL、部署或控制激活，也不构成新的生产通过证明。

## 源码与禁用边界

应用源码输入：@APPLICATION_SHA@，tree：@APPLICATION_TREE@。
这只是不可变 Git 源码绑定；真实 production alias、READY、公开版本及发布配置需由执行者另行核实。

十个 live 源码 pin 均按实际应用 Git blob 校验。只接受已审的 ad224 Coordinator 组件和 a65 persistent-cache 两个精确漂移；decoder 固定 490572a956f7675c1305f15394d75e1f6634cf3440da17fb3376dfb5189cf4e4。未知源变化拒绝准备。加载器只替换源码引用和两个 pin，不改产品算法。Hook 与组件用于来源核对，不在 Node 渲染 React。

继续使用原 ACME 自有工作区与 Haiku/Luna retained fixture receipt，不重建、不重新选模型。普通停止/工具未覆盖修正来自独立恢复 checkpoint 344fafb353d1128f89475bc827a404eff4520451，其四文件已单独离线 RED→14/14 GREEN；本稿没有新增生产 Stop 成绩。

continue.json 完全保留 fcce 原件：enabled=false、phase=tool、expectedSha=null、cacheTurns=3。continuation workflow 的 MIKKA_STOP_CASE 仍是 during_tool。
presence workflow 保持原 literal false 和空应用 SHA；legacy resume workflow/control 原样，不给没有 enabled 字段的旧控制文件添加或修改字段。
MCP workflow 保留 literal false、12 分钟 timeout 和原 reader/cleanup 路径，只清空旧应用 SHA。MCP 四个支持文件原样。

## 下一次缓存阶段的固定分母

未来只有 root 在确认实际部署后，另行将 continuation control 显式改为 enabled=true、phase=cache、expectedSha=该实际应用SHA、cacheTurns=3，才授权一轮缓存验收。单改源码 pin、上传本稿或 disabled job 成功都不是生产授权。

固定 Haiku 三轮、Luna 三轮，最多六次用户发送；后四槽 H2/H3/L2/L3 是预先定义的 warm 槽，每槽客户端 send→firstText 目标不超过 3000ms。失败、未发送和未覆盖保留原槽，不补跑、不只挑命中或较快结果。一次模型首轮失败会停止该模型的后续轮次；另一个模型通过独立进程/会话继续运行，保持两份独立 continuation wrapper 为权威收据。

phase=cache 不启动三 worker live 验收；旧 live 传输/核心消费者结果只按已审核源码兼容范围复用，不称为新窗口 React、浏览器或三 tab 通过。若将来需要 cache-live，必须另行授权，不能从本控制变更推导。

## 流、停止和证据

正常短回复以对应新 committed、持久化回复/cursor、权威 idle 收敛，再取消本 reader；持续 HTTP 的 EOF 不是回合成功前提。旧 prefix 不供新首字/新 committed 计数；真实 stream error、版本变化和 scope 不符仍失败。

普通 Stop 需本次 Stop ACK、同一新 committed、持久化 stopped 标记、idle，并核 live append/reset 最终正文与该 stream 新持久化正文一致。客户端读流关闭不等于 provider 物理停止。

工具没到真实边界仍是 failed/not_covered；自然无工具回复只有在严格持久化与 idle 确认后才省去多余 cleanup Stop。before/during 的分类仍须对应 server body/Stop/audit 区间，不凭 public running 或固定延迟宣布覆盖。

每个模型的 wrapper 保留真实发送、workflowRunId、所有失败和 cleanup；Actions step conclusion 不能代替内部 outcome。artifact 名仍为 issue-1506-alex-continue-<run_id>，包含 issue-1506-alex-report/*.json。Luna 早失败时不要用可能覆盖的 standalone 默认文件代替两份独立 wrapper。

服务端日志遵守既定最多 cache6+ordinaryStop2 共8个 exact-wrun 请求、每个一次 limit100；没有新增查询预算。rawCache 是 SDK 兼容 usage 边界，不是原 provider HTTP 字节；missing 不证明 provider 没返回。各独立时钟不跨钟相减，嵌套跨度不相加。

MCP 是独立、仍禁用的三 reader 阶段：latest、90s quiet、headers后5s abort；0模型、0业务写工具/聊天任务写入、0Stop、0MCP DELETE。正常 OAuth 创建/撤销会改变其授权记录，不能称所有 DB 零 mutation。未来实际执行需单独激活、服务器证据与授权清理，当前没有该通过证明。
