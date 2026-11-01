# The runner image: a clean Linux with the daemon's pinned Claude Code and
# Codex (harness/pins.json), the same harnesses a device installs for itself.
# A device with Docker runs each harness in a disposable container of it;
# the E2B template installs from the same pins and installer.
#
# Context: packages/daemon (or the npm package root). Multi-arch: the installer picks the build for the
# image's own arch, e.g.
#   docker buildx build --platform linux/amd64,linux/arm64 -f harness/Dockerfile .
# The base is the multi-arch node 24 index also pinned as HOSTED_NATIVE_IMAGE.
FROM node@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
COPY harness/pins.json harness/install.mjs harness/cli.mjs /opt/mikka/installer/
# An optional `--secret id=ca,src=<bundle>` trusts a proxy's CA while downloading.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && node /opt/mikka/installer/cli.mjs /opt/mikka/harness > /tmp/harnesses \
 && while read -r binary; do ln -sf "$binary" "/usr/local/bin/$(basename "$binary")"; done < /tmp/harnesses \
 && rm -rf /opt/mikka/installer /tmp/harnesses \
 && chmod -R go+rX,go-w /opt/mikka/harness \
 && claude --version && codex --version
