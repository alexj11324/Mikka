"""Exec a task command only after the kernel has applied its sandbox boundaries."""
import json
import os
import sys

with open("/proc/self/status", encoding="ascii") as status_file:
    status = dict(line.rstrip("\n").split(":\t", 1) for line in status_file if ":\t" in line)
capabilities = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")
if (
    os.getresuid() != (1000, 1000, 1000) or os.getresgid() != (1000, 1000, 1000)
    or os.getgroups() or os.getpid() != 1 or status.get("NoNewPrivs") != "1"
    or any(int(status[name], 16) for name in capabilities)
):
    raise SystemExit("Task process isolation unavailable")
options = json.loads(os.environ["MIKKA_TASK_PROCESS"])
env = {"HOME": "/home/node", "USER": "node", "LOGNAME": "node", "PATH": "/usr/local/bin:/usr/bin:/bin"}
env.update(options["env"])
os.chdir(options["cwd"])
os.execve("/bin/bash", ["bash", "-lc", options["command"]], env)
