# Local CUA backend follow-up (#147, #149)

The issue's 2026-10-30 owner comment supersedes its original default-ask
requirement: local computer operations use the server's persisted default-allow
authority, with deny and read-only restrictions still enforced. Remote desktop
uses the existing E2B path; this change does not restore Spaces/spacesd or add a
second protocol, policy table or frontend.

Already present in main: daemon discovery of the pinned optional `cua-driver`
0.38.0, device registration/heartbeat `computerUse`, per-run request-only proxy
injection into Claude Code/Codex/Cursor, live owner/workspace/device/policy
rechecks, no injection without a driver or authorization, deny/read-only
invalidation and untrusted-desktop-output instructions. The existing real Xvfb
and sandbox jobs previously passed in
[run 40790718847](https://github.com/alexj11324/Mikka/actions/runs/40790718847),
source `a25777f3c0b0846ffefeb506ee280151c85160ea`. This is historical evidence,
not a CI association or acceptance claim for the new patch.

The follow-up fixes three demonstrated gaps:

- `cloud-computer.yml` watched an obsolete topic branch only. It now runs the
  existing jobs for related daemon/protocol/CUA paths in PRs and on main. Linux
  Xvfb remains required. The daemon test step receives its already required
  `NODE_ENV=test` / `MIKKA_TEST_MODE=1`, without relaxing production guards.
- The real fixture now follows default allow without human review, verifies a
  screenshot/click transition and typed text received by an isolated
  application. Its new Linux input step reproduced `background_unavailable`:
  `type_text` omitted both desktop scope and foreground delivery, while click
  and press_key already provided them. The adapter now supplies the same
  explicit desktop/foreground mode for typing. The pinned actual driver's
  `tools/list` metadata confirms both parameters and default background mode.
  No uinput access, privileged container or accessibility bypass is introduced.
- CUA's MIT notice was absent and daemon builds omitted existing third-party
  notices. The notice now contains the exact upstream 2025 Cua AI, Inc. MIT
  text and revision; the npm candidate includes `THIRD_PARTY_NOTICES.md`.
  A nonblocking hosted macOS job uses the upstream universal standalone
  archive and the same screenshot/input/click fixture. It does not alter TCC
  or imply real-user macOS permissions were verified.

Archive identities were read from the official release API for upstream
`cua-driver-rs-v0.38.0`, revision
`85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`:

| Standalone archive | SHA-256 |
| --- | --- |
| Linux x86_64 binary | `31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd` |
| Darwin universal binary | `2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732` |

The Rust workspace declares MIT and upstream `LICENSE.md` supplies the copied
copyright. No perception/OmniParser/Spaces extension was installed. The driver
fixture uses a private HOME with telemetry disabled; it never reads the user's
browser, accounts or Mac.

Validation in cloud Linux: 29 broker/proxy/permission tests and four real-daemon/
adapter configuration tests passed without skips, using the existing explicit
synthetic CLI fixtures. A small daemon build plus actual `npm pack --dry-run`
confirmed the notice is included (36 candidate files). JavaScript syntax,
workflow YAML and required-Linux/nonblocking-mac settings passed. A supplemental
standalone lint run exposed the pre-existing `no-unused-expressions` ternary
in driver response handling; the repository's normal root lint excludes
packages. No unrelated lint rewrite was added.

A fresh isolated Docker/Xvfb run reached real screenshot and dialog click,
then failed at the newly added typing assertion before the fix, establishing
the actual defect. Logs and metadata remain under `/tmp/mikka-149-*`, including
`cua-linux-run.log`, `source-tests.log`, `daemon-adapter-tests.log` and
`cua-linux-assets/type-text-schema.json`; the latter came from the actual
pinned binary without invoking any desktop action. Binary, archive and the
initial screenshot remain in `cua-linux-assets`.
The new disposable container exhausted the shared filesystem during package
installation. It was removed immediately on the coordinator's instruction;
no old container, database, dependencies or evidence was removed, and more
than 680 MB was restored. No further local install/container run is needed.
The **post-fix full Xvfb input flow remains to be run in the associated CI**;
unit argument/schema checks are not described as that positive result.

Practical input failure estimate: occurrence 8 × impact 6 = 48, supported by
that ordinary Xvfb execution and the actual tool schema. Default background
input is unavailable on that desktop; this is not a hypothetical corner case.

Do not close the overall #147/#149 solely from these source/component results.
Still needed: the associated new Linux CI result, the explicitly nonblocking
hosted macOS observation and the issue's final authorized real-model/real-Mac
permission acceptance. No user Mac was accessed or requested for this patch.
