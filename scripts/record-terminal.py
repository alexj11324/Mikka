"""Record actual subprocess PTY output in asciinema v2 format (no shell)."""
import json
import os
import pty
import subprocess
import sys
import time

path, *command = sys.argv[1:]
started = time.monotonic()
master, slave = pty.openpty()
with open(path, 'w') as recording:
    recording.write(json.dumps({'version': 2, 'width': 120, 'height': 35,
        'timestamp': int(time.time()), 'title': 'Mikka actual backend acceptance'}) + '\n')
    recording.flush()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=slave, stderr=slave)
    os.close(slave)
    while True:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        chunk = data.decode('utf-8', 'replace')
        sys.stdout.write(chunk)
        sys.stdout.flush()
        recording.write(json.dumps([round(time.monotonic() - started, 6), 'o', chunk]) + '\n')
        recording.flush()
    os.close(master)
    sys.exit(process.wait())
