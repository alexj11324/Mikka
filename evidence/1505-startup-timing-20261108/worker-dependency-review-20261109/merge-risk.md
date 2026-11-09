## 合并风险评估：中等（head 5fde6ffa）

依据仓库 [merge-risk 规则](https://github.com/alexj11324/Mikka/blob/5fde6ffae3c01769b69aa9c14abec26f2ceddfda/.claude/skills/merge-risk/SKILL.md)，独立审查精确五文件diff及[冻结证据](https://github.com/alexj11324/Mikka/tree/e7ce8d5826aaf573e026a2ad838ebe71030c8772/evidence/1505-startup-timing-20261108/worker-dependency-boundary-20261109)。本评估不代替源码CI、实际模板发布或#1505生产验收。

| 维度 | 判断与依据 |
| --- | --- |
| 目标一致性 | 良好。针对固定pnpm共享锁安装误带root importer的已复现问题；实际A024两次模板发布分别受ffmpeg binary、LICENSE 504阻塞。仅改私有安装闭包、bootstrap接线、对应回归/CI和原ADR，没有附带业务改动。 |
| 影响范围 | 中等。影响三个官方派生模板及原bootstrap安装路径。新增内容在同一个/opt/mikka release内，原source/lock/官方文件与原构建入口保留；没有改任务鉴权、凭据交付、数据库或模型权限，也未扩大安装脚本许可。 |
| 验证充分性 | 当前充分但仍有明确后续门槛。空缓存正常脚本安装、37直接依赖、原构建/SDK解析、整release搬迁、非属主读取、5/5与32/32回归、精确候选W的2/9/16/12资源验证均有原件。截至06:32的完整远端CI仍有Image/Apple两项在途；本地Node24.22.1与模板24.19.0的差异保留。新官方守恒、真实双订阅、生产发布和六例测速尚未执行。 |
| 回滚成本 | 低。无迁移、用户数据改写或不可逆外部动作；旧有效release保留，可通过正常revert PR及既有发布元组回退。回退仍须核source/W/templates/Web一致性，不能只移一个指针就报恢复。 |
| 错误发现能力 | 良好。缺失/重复importer、闭包外workspace link、锁摘要变化、既有目标链接或缺安装目录直接失败；正常frozen install和原构建/官方守恒/双订阅/发布/cleanup门槛保持。没有静默降为非冻结解析或跳过脚本。 |

**发生8/10 × 影响6/10 = 48。**这是对当前安装边界缺陷的工程判断，不是HTTP504发生率估计；依据为精确pnpm复现、实际A024安装验证及两次真实发布失败。审查未发现新的可复现产品阻断，不扩展成通用YAML解析或新的依赖系统。

**新main合流核验（06:36:12 UTC）：**main `927260894305e066e15a4ad50114abce433e6001` 相对88实际六条原生claim/交付上下文及生成索引路径，与本PR五路径交集为空。正常merge-tree无冲突，prospective tree `2c5c05f5d99dc230eb5fa8edafee143ffa727316`；除本PR五条精确叶子外，其他6726条main叶子完全保留。用相同正式hash脚本核88/927的W相同、5fde/prospective的W同为 `cd10b53c37242736be3bb91b841f2220772a1681`。这不是已发布pin，也不是新合流CI执行证明。

开发VM已于 **06:36:50.118 UTC** 停止，独立GET确认stopped/routes=[]；没有为CI等待保留计算资源。正式CC×3/CX×3仍0，旧FAIL和5000ms原公式不变，#1505继续OPEN。
