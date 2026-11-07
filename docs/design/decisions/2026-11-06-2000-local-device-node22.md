# Local device daemons support Node.js 22

Date: 2026-11-06
Source: Alex, #1517: “我记得我有要求，我们要兼容 22”.
Rule IDs: —
Replaces: the daemon's Node >=24 requirement introduced on 2026-10-30.

Local device daemons require Node.js 22 or newer. The cloud application continues to use Node.js 24. Installer preflight and the published daemon's engine/build target share this minimum. Existing nvm, fnm, Volta and Homebrew installations are discoverable from a desktop launched by Finder without depending on interactive shell startup.

A desktop installs its daemon and npm cache under its own user's `.mikka` directory. It carries the selected Node directory into service installation and subsequent commands; it neither requests sudo nor changes shell profiles. Installation failures expose a stable cause and remedy separately from the complete, credential-redacted diagnostic log. The existing reason field retains that diagnostic for older desktop versions to expand, and a private local log keeps the same evidence.

A future device heartbeat is offline and cannot receive work. Settings reads expose dispatch order and per-node explanations from the same planner used for new runs, using existing live notifications. Demo device generation is retired; existing demo devices are stopped and removed through normal business operations, preserving historical runs.
