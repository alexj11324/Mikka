// Current templates compile ahead of time; old task snapshots remain resumable.
// No credential enters this command, its argv or environment.
export const CLOUD_WORKER_COMMAND = 'cd /opt/mikka/worker/packages/daemon && { export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH; export HOME=/home/user; read -r preload_pid < /home/user/.mikka/preloaded.pid 2>/dev/null || preload_pid=; if test -n "$preload_pid" && test -r "/proc/$preload_pid/cmdline" && tr "\\0" "\\n" < "/proc/$preload_pid/cmdline" | grep -Fxq -- "--wait-bootstrap" && kill -0 "$preload_pid" 2>/dev/null; then kill -USR1 "$preload_pid"; elif test -f dist/cloud/cloud-worker.js; then node dist/cloud/cloud-worker.js; else ./node_modules/.bin/tsx bin/cloud-worker.ts; fi; }'
// A ready pooled instance (thread-machine-pool.ts) loads the worker before it
// pauses; CLOUD_WORKER_COMMAND then wakes it instead of starting a new one.
export const CLOUD_WORKER_PRELOAD_COMMAND = 'cd /opt/mikka/worker/packages/daemon && export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH && export HOME=/home/user && exec node dist/cloud/cloud-worker.js --wait-bootstrap'
