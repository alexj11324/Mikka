#!/bin/bash
set -euo pipefail
id=${1:?subagent id required}
[[ "$id" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 2
umask 077
mkdir -p "/home/user/.mikka/subagents/$id"
exec 9>"/home/user/.mikka/subagents/$id/launch.lock"
flock -n 9 || exit 0
exec node /opt/mikka/computer/subagent-browser.mjs "$id"
