# 独立 PostgreSQL 17 开发回归实例

仅供本次 CI PG1 单文件 fixture 回归。PostgreSQL 17.11 server/client 来自官方 PGDG resolute-pgdg amd64 签名仓库；InRelease 签名、Packages 索引及每个 .deb SHA 已核。缺失的 libLLVM.so.21.1 来自本机已信任的 Ubuntu 官方 apt 索引（libllvm21 1:21.1.8-6ubuntu1），校验包 SHA 后同样隔离解包。

所有二进制/库在此 runtime 子树；未运行 package maintainer scripts、没有修改已有 PostgreSQL 18 cluster 或服务。实例以当前非root用户启动，仅监听127.0.0.1:55485，Unix socket目录0700；host trust只允许127.0.0.1/32，其余IPv4/IPv6拒绝。本地专用管理员 mikka_1505_pg1，数据库 mikka_1505_pg1_e2e。客户端使用本目录空0600 pgpass，不读取外部密码文件。

本机连接（仅开发、无外部凭据）：
postgresql://mikka_1505_pg1@127.0.0.1:55485/mikka_1505_pg1_e2e

已完成初始化，不要再次执行bootstrap.py：它明确拒绝已有data目录。
如确需重新启动这个已停实例：
env LD_LIBRARY_PATH=/vercel/ops-1505/ci-pg1-local-db/runtime/usr/lib/x86_64-linux-gnu /vercel/ops-1505/ci-pg1-local-db/runtime/usr/lib/postgresql/17/bin/pg_ctl -D /vercel/ops-1505/ci-pg1-local-db/data -l /vercel/ops-1505/ci-pg1-local-db/logs/server.log -w -t 30 start

使用结束停止本实例：
/vercel/ops-1505/ci-pg1-local-db/runtime/usr/lib/postgresql/17/bin/pg_ctl -D /vercel/ops-1505/ci-pg1-local-db/data -m fast -w -t 30 stop

保留原失败：第一次包选择错误假设每包只有一个minor，实际签名仓库有三个，未启动DB；修正为精确17.11。第一次bootstrap已成功initdb/createDB，但将psql的/dev/null pgpass警告与JSON一起解析而失败；失败处理确实停止了本实例。改为专用空0600普通文件后重启和健康查询成功，未重新初始化。没有把这些本地准备失败写成产品/CI失败，也未运行测试或生产SQL。

instance.json记录04:40:49就绪时的实际server/version/database/superuser/listener/PID。此后root负责唯一回归和停机；本manifest不声称之后的运行状态。server.log与data目录会随运行改变，不纳入冻结成员哈希。
