# Bundle the desktop UI locally

- Date: 2026-11-05
- Source: Alex, [#1415](https://github.com/alexj11324/Mikka/issues/1415), and the implementation request: complete the acceptance checklist without intermediate confirmation; prefer the agent's existing VM before Docker Agentic Platform.
- Rules: R-23, R-35, R-90 (unchanged shared UI and native capabilities).
- Replaces: the hosted-renderer part of the 2026-10-29 desktop decision and the window-owned web session in `../platforms.md`.

The macOS Apple Silicon app bundles Mikka's existing React components, tokens,
fonts and styles. The main window loads those packaged assets through a local
protocol. Web continues to use Next.js; this is not a second UI or a redesign.

The Electron main process owns the session and forwards authenticated API
requests. Neither the session credential nor a live-push ticket belongs in the
renderer. Third-party sign-in stays in the system browser and returns through
the existing one-use loopback handoff. IPC, CSP and navigation restrictions
remain enforced. Local packaging adds no polling or broader database reads.

This work stays on `desktop/bundled-renderer` in a draft PR. Acceptance uses
isolated environments and an unsigned `Mikka Dev` test package. It does not
merge, publish a desktop release, or change production data or settings. A
hosted-renderer switch remains during this transition for explicit rollback.

The issue's Electron acceptance and pixel comparison are required for this
architecture change; they are the task-specific exception to the ordinary
no-browser-test workflow. Checks are evidence, not approval gates for Alex.
