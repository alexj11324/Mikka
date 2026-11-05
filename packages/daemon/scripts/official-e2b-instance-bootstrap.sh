#!/bin/bash
# Add Mikka to a new official E2B instance. Never build/update a template or
# overwrite/remove official packages, system files or the original CLI tree.
set -euo pipefail
mikka_commit=${1:?source commit required}
mikka_sha=${2:?worker digest required}
mikka_kind=${3:?official template kind required}
mikka_mode=${4:-install}
mikka_previous_sha=${5:-}
[[ "$mikka_mode" = install || "$mikka_mode" = stage ]] || exit 2
[[ "$mikka_commit" =~ ^[a-f0-9]{40}$ && "$mikka_sha" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$mikka_kind" = desktop || "$mikka_kind" = claude || "$mikka_kind" = codex ]] || exit 2
[[ "$(uname -s)/$(uname -m)" = Linux/x86_64 ]] || exit 2
if [[ "$mikka_mode" = stage ]]; then
  [[ "$mikka_previous_sha" =~ ^[a-f0-9]{40}$ && -f /opt/mikka/worker-source-sha && ! -L /opt/mikka/worker-source-sha ]] || exit 3
  [[ "$(stat -c %u /opt/mikka/worker-source-sha)" = 0 && "$(cat /opt/mikka/worker-source-sha)" = "$mikka_previous_sha" ]] || exit 3
  [[ -x /opt/mikka/runtime/node/bin/node && -L /opt/mikka/worker ]] || exit 3
elif [[ -f /opt/mikka/worker-source-sha ]]; then
  [[ "$(cat /opt/mikka/worker-source-sha)" = "$mikka_sha" ]] || exit 3
  exit 0
fi
# Refuse an unknown installation. Retained/legacy instances are never erased
# or patched into the new runtime; normal scheduling selects a fresh instance.
if [[ "$mikka_mode" = install ]]; then [[ ! -e /opt/mikka/worker && ! -L /opt/mikka/worker ]] || exit 3; fi
mkdir -p /opt/mikka/archives /opt/mikka/runtime /opt/mikka/releases
mikka_destination=/opt/mikka/releases/$mikka_commit
mikka_release=$mikka_destination
if [[ -e "$mikka_release" || -L "$mikka_release" ]]; then
  [[ "$mikka_mode" = stage && -d "$mikka_release/source" && ! -L "$mikka_release" && ! -L "$mikka_release/source" && -f "$mikka_release/worker-ready.sha" && ! -L "$mikka_release/worker-ready.sha" ]] || exit 3
  for mikka_owned in "$mikka_release" "$mikka_release/source" "$mikka_release/worker-ready.sha"; do
    [[ "$(stat -c %u "$mikka_owned")" = 0 ]] || exit 3
  done
  [[ "$(cat "$mikka_release/worker-ready.sha")" = "$mikka_sha" ]] || exit 3
  [[ "$(git -C "$mikka_release/source" rev-parse HEAD)" = "$mikka_commit" ]] || exit 3
  printf 'mikka-official-instance-staged %s %s\n' "$mikka_commit" "$mikka_sha"
  exit 0
fi
if [[ "$mikka_mode" = stage ]]; then
  # A failed fetch/build leaves only a private diagnostic directory. The fixed
  # source path becomes visible only after the complete release is ready.
  umask 022
  mikka_release=$(mktemp -d "/opt/mikka/releases/.stage-$mikka_commit-XXXXXXXX")
else
  mkdir "$mikka_release"
fi
git -c core.hooksPath=/dev/null init -q "$mikka_release/source"
git -C "$mikka_release/source" -c core.hooksPath=/dev/null remote add origin https://github.com/alexj11324/Mikka.git
git -C "$mikka_release/source" -c core.hooksPath=/dev/null fetch -q --depth=1 origin "$mikka_commit"
git -C "$mikka_release/source" -c core.hooksPath=/dev/null checkout -q --detach FETCH_HEAD
[[ "$(git -C "$mikka_release/source" rev-parse HEAD)" = "$mikka_commit" ]] || exit 3
mikka_actual_sha=$(cd "$mikka_release/source" && python3 scripts/e2b/build-template.py --worker-hash --source-ref HEAD)
[[ "$mikka_actual_sha" = "$mikka_sha" ]] || exit 3
if [[ "$mikka_mode" = install ]]; then
mikka_node_archive=/opt/mikka/archives/node-v24.19.0-linux-x64.tar.xz
curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -o "$mikka_node_archive"
echo "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  $mikka_node_archive" | sha256sum --check --strict
tar -xJf "$mikka_node_archive" -C /opt/mikka/runtime
ln -s node-v24.19.0-linux-x64 /opt/mikka/runtime/node
export PATH=/opt/mikka/runtime/node/bin:$PATH
mkdir -p /opt/mikka/runtime/bootstrap-home /opt/mikka/runtime/harness-bin
if ! command -v gh >/dev/null; then
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 https://github.com/cli/cli/releases/download/v2.83.2/gh_2.83.2_linux_amd64.tar.gz -o /opt/mikka/archives/gh_2.83.2_linux_amd64.tar.gz
  echo 'ca6e7641214fbd0e21429cec4b64a7ba626fd946d8f9d6d191467545b092015e  /opt/mikka/archives/gh_2.83.2_linux_amd64.tar.gz' | sha256sum --check --strict
  tar -xzf /opt/mikka/archives/gh_2.83.2_linux_amd64.tar.gz -C /opt/mikka/runtime
  ln -s /opt/mikka/runtime/gh_2.83.2_linux_amd64/bin/gh /opt/mikka/runtime/harness-bin/gh
fi
fi
export PATH=/opt/mikka/runtime/node/bin:$PATH
cd "$mikka_release/source"
env HOME=/opt/mikka/runtime/bootstrap-home COREPACK_HOME=/opt/mikka/runtime/corepack corepack pnpm install --filter @mikka/daemon... --frozen-lockfile
node packages/daemon/scripts/build-cloud-worker.mjs
printf '%s\n' "$mikka_sha" > "$mikka_release/worker-ready.sha"
chmod -R go-w "$mikka_release"
if [[ "$mikka_mode" = stage ]]; then
  chmod 0755 "$mikka_release"
  # -T refuses a conflicting destination; never nest/overwrite a prior release.
  mv -T --no-clobber "$mikka_release" "$mikka_destination"
  [[ ! -e "$mikka_release" && ! -L "$mikka_release" ]] || exit 3
  printf 'mikka-official-instance-staged %s %s\n' "$mikka_commit" "$mikka_sha"
  exit 0
fi
# Official task CLIs stay in place. Only a desktop without Codex needs the
# complete pinned package in Mikka's private directory; no global bin is changed.
if ! command -v codex >/dev/null; then
  mikka_codex=$(node packages/daemon/harness/cli.mjs /opt/mikka/harness codex)
  ln -s "$mikka_codex" /opt/mikka/runtime/harness-bin/codex
  mikka_codex_root=$(dirname "$(dirname "$mikka_codex")")
  if [[ -x "$mikka_codex_root/codex-path/rg" ]]; then ln -s "$mikka_codex_root/codex-path/rg" /opt/mikka/runtime/harness-bin/rg; fi
  chmod -R go+rX /opt/mikka/harness
fi
# Only the fresh install path reaches here: staging exits above, an installed
# marker returns above, and an unknown private worker installation is refused.
# Persist an empty journal before registration/claim. A rejected first claim
# never reaches RunJournal.put(), but a later idle refresh still needs a real
# journal. Existing/legacy worker data is never repaired or overwritten here.
python3 - <<'MIKKA_INITIAL_WORKER_JOURNAL'
import os,pathlib,pwd,stat
home=pathlib.Path('/home/user/.mikka')
account=pwd.getpwnam('user')
try:
    if home.is_symlink():raise RuntimeError()
    try:home.mkdir(mode=0o700)
    except FileExistsError:pass
    else:os.chown(home,account.pw_uid,account.pw_gid)
    home_fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(home_fd)
        if info.st_uid!=account.pw_uid or info.st_mode & 0o022:raise RuntimeError()
        # mkdir must succeed exclusively, including for a dangling symlink.
        # The directory remains root-owned until its complete journal is safe.
        os.mkdir('worker',mode=0o700,dir_fd=home_fd)
        worker_fd=os.open('worker',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=home_fd)
        try:
            fd=os.open('runs.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=worker_fd)
            with os.fdopen(fd,'w') as handle:
                handle.write('{"version":1,"runs":{}}\n');handle.flush()
                os.fchmod(handle.fileno(),0o600);os.fchown(handle.fileno(),account.pw_uid,account.pw_gid);os.fsync(handle.fileno())
            os.fchown(worker_fd,account.pw_uid,account.pw_gid);os.fsync(worker_fd)
        finally:os.close(worker_fd)
        os.fsync(home_fd)
    finally:os.close(home_fd)
except Exception:
    raise SystemExit('runtime_initial_journal_refused')
MIKKA_INITIAL_WORKER_JOURNAL
ln -s "$mikka_release/source" /opt/mikka/worker
if [[ "$mikka_kind" = desktop ]]; then
  mkdir -p /opt/mikka/computer/desktop-config/xfce4/xfconf/xfce-perchannel-xml /opt/mikka/computer/desktop-config/autostart
  env HOME=/opt/mikka/runtime/bootstrap-home PIP_CACHE_DIR=/opt/mikka/runtime/pip-cache python3 -m pip install --target /opt/mikka/computer 'aiohttp==3.13.3'
  cp scripts/e2b/start-desktop.sh scripts/e2b/viewer-gateway.py scripts/e2b/lease-driver.py /opt/mikka/computer/
  cp /home/user/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml /opt/mikka/computer/desktop-config/xfce4/xfconf/xfce-perchannel-xml/
  cp /home/user/.config/autostart/screensaver.desktop /opt/mikka/computer/desktop-config/autostart/
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz -o /opt/mikka/archives/cua-driver.tar.gz
  echo '31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd  /opt/mikka/archives/cua-driver.tar.gz' | sha256sum --check --strict
  tar -xzf /opt/mikka/archives/cua-driver.tar.gz -C /opt/mikka/computer
  chmod 0755 /opt/mikka/computer/start-desktop.sh /opt/mikka/computer/lease-driver.py
fi
install -d -m 710 -o root -g user /run/mikka-viewer
chmod -R go-w "$mikka_release"
printf '%s\n' "$mikka_sha" > /opt/mikka/worker-source-sha
chmod 0444 /opt/mikka/worker-source-sha
printf 'mikka-official-instance-ready %s %s\n' "$mikka_commit" "$mikka_sha"
