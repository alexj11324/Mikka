# Workspace readiness and draft retention

Captured from official local Node production build `d58ea6c90fc2ad1ad322256ffa0d5c34875c1ffd` with UI overlay `0a6e897339d4f4834d78846e55dc4cda4ed2a599`, Chromium, and an owned disposable PostgreSQL 17 database. The browser uses an ordinary leased email-auth account; mail stays in a loopback SMTP sink. The application version response matches the source and overlay revisions. [Capture metadata](capture.json) records the browser version and checks.

| State, 1440 × 1000 | Light | Dark |
| --- | --- | --- |
| Workspace read pending; no editable composer | [Loading](workspace-loading-light-1440.png) | [Loading](workspace-loading-dark-1440.png) |
| Workspace resolved; draft retained after a full reload | [Ready draft](workspace-ready-draft-light-1440.png) | [Ready draft](workspace-ready-draft-dark-1440.png) |

The driver holds the real `GET /mikka/api/workspace` request before continuing it unchanged. It checks that the existing `WorkspaceLoading` component is visible and no chat composer is exposed during that interval. After the real response, it types `Lifecycle readiness draft`, verifies retention after the native empty-create response, reloads the document, and verifies that the same scoped draft is restored. No HTTP response, provider result, private SDK store, or component state is substituted. No model message, welcome, task, send, or answer is submitted.

The change reuses `WorkspaceLoading`, `InlineLoadError`, and the official `ThreadScreen` composer. Paid blocks and the ready-state markup retain their shipped appearance. The delayed-workspace component regression also checks workspace/account isolation and restoration when returning to the original scope; a failed-read regression checks the ordinary read retry. These images verify the official Web renderer. The packaged macOS lifecycle check separately verifies Electron cold launches.

The owning agent reviewed all four images: the pending state exposes no composer, the restored draft is visible in both themes, and no clipping, horizontal overflow, framework overlay, or JavaScript exception appears. After the browser closes, the unchanged generated-workspace-name guard restores the exact localized fixture name and proves both account baselines before the lease releases cleanly. [Cleanup evidence](cleanup.json) contains only closed status fields.
