# syntax=docker/dockerfile:1
FROM cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec AS sandbox-tools
FROM node:24.22.1-trixie@sha256:f1e034976f948cf212ef1f659c12e5dd58ac7eab947831813e81a62401ca38be AS worker-build
WORKDIR /source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/ packages/config/
COPY packages/protocol/ packages/protocol/
COPY packages/daemon/ packages/daemon/
COPY patches/ patches/
RUN python3 packages/daemon/scripts/prepare-worker-install.py /source /opt/mikka/worker
WORKDIR /opt/mikka/worker
RUN corepack pnpm install --filter @mikka/daemon... --frozen-lockfile \
    && (cd packages/daemon && node --import tsx --test test/cloudflare-task-handoff.node-test.ts) \
    && node packages/daemon/scripts/build-cloud-worker.mjs \
    && CI=true corepack pnpm install --filter @mikka/daemon... --prod --offline --frozen-lockfile

FROM node:24.22.1-trixie@sha256:f1e034976f948cf212ef1f659c12e5dd58ac7eab947831813e81a62401ca38be
COPY --from=worker-build /opt/mikka/worker /opt/mikka/worker
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY cloudflare/task-sandbox/runtime/ /opt/mikka/task-sandbox/
COPY packages/daemon/harness/ /opt/mikka/install-harness/
RUN test -x /usr/bin/setpriv && test -x /usr/bin/unshare && test -x /usr/bin/python3 \
    && install -d -o node -g node -m 0700 /workspace \
    && node /opt/mikka/install-harness/cli.mjs /opt/mikka/harness claude_code codex \
    && chmod -R a+rX /opt/mikka/harness \
    && node --input-type=module -e "import { symlinkSync } from 'node:fs'; import { harnessBinaryPath } from '/opt/mikka/install-harness/install.mjs'; for (const [h,bin] of [['claude_code','claude'],['codex','codex']]) symlinkSync(harnessBinaryPath({root:'/opt/mikka/harness'}, h), '/usr/local/bin/'+bin)"
# This read-only image manifest names the same pinned executables used by
# the daemon and by the offline release gate. Task user commands cannot edit it.
RUN node /opt/mikka/task-sandbox/record-binaries.mjs
WORKDIR /workspace
CMD ["sleep", "900"]
