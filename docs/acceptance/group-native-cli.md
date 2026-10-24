# Native group-review CLI contract

This mode is separate from repository coding sessions. The owning Agent's harness is derived by the authorized server claim from its persisted mailbox/Agent identity. Neither comments nor peer request fields choose a binary, image, owner, workspace or private session. Harness drift is rejected. Model output contains only `body` and nullable full revised `content`; the host supplies original Artifact/base/hash bindings. Completion and human acceptance remain distinct.

## Official interface research

Reviewed 2026-10-24 against primary vendor documentation:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): print mode, JSON/schema output, bare/restricted mode, empty built-in tool set, disallowed tools, strict MCP configuration, settings sources and session-persistence flags. The reference states restricted mode requires 2.1.248 or later; this implementation deliberately accepts only the narrower 2.1.290 compatibility contract and verifies required help flags at startup.
- [Claude programmatic execution](https://code.claude.com/docs/en/headless): noninteractive CLI result handling. The adapter requires a successful structured result and validates it again locally.
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference): noninteractive exec, stdin prompt, ephemeral execution, ignoring user configuration, skipping Git checks, read-only sandbox, JSON events, output schema and final-message file.
- [Codex configuration reference](https://developers.openai.com/codex/config-reference) and [version-pinned official config schema](https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/codex-rs/core/config.schema.json): shell/tool controls, web search, project instruction loading and MCP configuration. Codex accepts only the 0.162.1 compatibility contract. The pinned schema accepts boolean `features.multi_agent_v2`; enabling it takes precedence over `agents.enabled`, so both multi-agent feature generations are explicitly disabled. Startup requires exactly one disabled row for each required feature in actual `features list` output under these overrides, plus required exec help flags. Unknown/missing/true controls fail closed.

These are explicit supported-contract pins. A genuine official Codex 0.162.1 Linux binary, downloaded anonymously with registry SHA-512 integrity verified, passed the isolated offline version/help/features startup probe. No prompt, authentication or inference was invoked. Genuine Claude execution was not tested. New versions require review and tests. No speculative isolation flag is used. CLI controls alone are not the host isolation boundary.

## Startup and isolation

`mikka daemon --group-review-images <manifest.json>` or `DaemonOptions.groupReviewImages` selects locally available immutable Docker image IDs, keyed only by `claude_code`/`codex`. No floating image tags or implicit image pulls are accepted. Images must include Node at `/usr/local/bin/node` and the selected CLI at `/usr/local/bin/claude` or `/usr/local/bin/codex`. Images are an explicitly configured trusted runtime dependency; no installation, image download, credential extraction or automatic update is performed by this mode.

The daemon probes compatibility before activating the group processor. A normal daemon with no group image manifest does not claim this work. Missing Docker, unavailable images, unsupported versions or missing capabilities fail closed; repository adapters are never used as a fallback.

Each execution has a new unprivileged container, read-only image root, fresh bounded scratch/home, no host home/repository/auth/session mounts, no privileges/Linux capabilities, bounded CPU/memory/PIDs, and only the read-only trusted runtime script mounted. Native child environment is constructed explicitly. Supplied group content enters over stdin. Neither native private auth stores nor MCP worker tokens are copied into the container. No private CLI session is resumed.

Readiness, startup probes, execution and forced cleanup all use the same explicit local Unix Docker socket, fresh private Docker configuration and constructed environment. Inherited Docker host/context/config/auth variables cannot redirect any phase. Private configuration is removed after active containers finish cleanup or startup fails. Configured images remain trusted operator-supplied dependencies; an immutable ID alone does not prove that image contents are clean.

Networking is `none`. This is intentional and enforced by Docker, not a prompt. Consequently genuine cloud-provider inference/authentication remains unavailable in this configuration. No provider key, OAuth/login or model-only egress service was approved or configured in this task. Enabling genuine inference requires a separately approved narrow model-auth/egress boundary; an unrestricted bridge network or mounted host login is not an acceptable shortcut. This document does not claim production live-provider acceptance.

Claude uses an empty tool set, denied tools, bare/restricted configuration and a replacement task prompt. Codex disables required shell/patch/multi-agent controls, web search, image tools and project-document loading, with empty MCP configuration. Unexpected tool events are rejected during result admission; this guard does not prevent an attempted tool call. These are additional defenses; the container protects host context even if a CLI's internal tool behavior differs. Genuine vendor execution-time handling of these controls is not established by fake binaries or an offline startup probe.

## Runtime limits and errors

Input/output byte streams and result fields are bounded; Unicode is decoded only after complete buffering. Result shape is strict, including 32,000-character reply and 1,000,000-character content limits. Malformed/oversized output, tool events or failed CLI execution cannot create a reply, revision or acceptance. The current authenticated claim can submit a fixed failure code, producing a visible cancelled work status and generic runtime error; arbitrary stderr/model text is not exposed as an error message.

Both subprocess readers wait for stdio `close`, not merely process exit, before parsing results. Controlled regressions keep stdout open in a descendant, emit delayed chunks and a late tool event, and verify complete Unicode output or rejection respectively.

The existing claim epoch, 90-second lease, 60-second compute limit and revocation checks remain authoritative. Old/expired claims cannot complete or fail a newer attempt. Failed output is terminal; interrupted/replayed claims are bounded to three attempts. A stopped daemon aborts its processor. Cancellation never grants a late write or approval.

## Controlled acceptance

`test:group-native` enables the native fixture phase of the real HTTP/Postgres group suite. It starts the actual daemon with image configuration, rather than injecting the old processor callback. Controlled fake executables implement each vendor's documented CLI surface inside task-built local images; they never call a provider. Checks include both harness routes, large Unicode context/results, delayed stdout, empty private context/environment, poisoned Docker environment, read-only root and unavailable network, duplicate completion, stale epoch, cancellation/container cleanup, concurrent Artifact revisions, malformed/oversized/extra-field results, unexpected Codex tools and unsupported version/capability images. Positive HTTP identity is a controlled fixture; this is not OAuth/device-login acceptance.

Frontend remains frozen. This implementation changes backend/daemon contracts only and does not establish Figma or UI acceptance.
