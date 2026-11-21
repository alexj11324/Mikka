"""Stop task PID namespaces before the trusted backup process reads the workspace."""
import os
import select
import signal
import time

deadline = time.monotonic() + 5
while True:
    found = False
    with os.scandir("/proc") as entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                pid = int(entry.name)
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                with open(entry.path + "/status", encoding="ascii") as status_file:
                    status = dict(line.rstrip("\n").split(":\t", 1) for line in status_file if ":\t" in line)
                if status["State"].startswith("Z"):
                    continue
                uid = int(status["Uid"].split()[0])
                # Only the trusted launcher creates a root-owned unshare supervisor.
                # A task's session or process-group changes do not escape its PID namespace.
                task = uid == 1000 or (uid == 0 and os.readlink(entry.path + "/exe") == "/usr/bin/unshare")
                if not task:
                    continue
                found = True
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                poller = select.poll()
                poller.register(fd, select.POLLIN)
                poller.poll(max(0, min(100, int((deadline - time.monotonic()) * 1000))))
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                os.close(fd)
    if not found:
        break
    if time.monotonic() >= deadline:
        raise SystemExit("Task writers still active")
