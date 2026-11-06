# Issue 1415: Linux native parity diagnostic (7973 / 5c0b605a)

## Recorded result

The original run **failed: 58 of 100 comparisons passed, 42 failed**. Cleanup passed. The evidence has not been relabeled or overwritten after investigation.

- Application and daemon source: `7973afa9ad8cd3aaaaca0e5a12c05e3de8fd791d`.
- Harness SHA-256: `5c0b605af0d51ea47c9cf95eaaaef208f30c549660871abc8f4ecea4358241c0`.
- Run: 2026-11-05 23:45:27.945–23:48:39.942 UTC.
- Viewport: 1440 × 900, DPR 1, visual scale 1, UTC; light and dark.
- Comparison: exact RGBA pixels, maximum changed ratio 0.001 (0.1%); existing avatar/time masks only.
- One owned profile, modes captured sequentially; actual browser/loopback/PKCE sign-in and the real authenticated backend.
- The Linux host used the **official foreground CLI** because it has no user service manager. Owner, profile, process, sign-in, registration and server-online state were verified. This is **unmanaged** operation; `automaticServiceAcceptance=false`. It does not establish automatic service installation or managed update acceptance.
- Exact native resource cleanup removed this run's handoff, device, token, link and two agents. Fixture cleanup and account lease release passed. The final checks found no owned native profiles or Electron processes.

[Complete original evidence archive](https://chatgpt.com/library?file_id=libfile_9ee5821724e88191bc5cafcfb21b8298&account_id=personal): 14,700,326 bytes, 326 files, including 200 original screenshots and 100 difference images. SHA-256: `42b1c1b85d699b0250434a477b496eecfca14ccf78c0db89990cd2146f268df6`. It also preserves the preceding failed harness-location attempt and its verified drain.

## Findings and bounded changes

| Original failures | Evidence and cause | Change |
| --- | --- | --- |
| 38 comparisons across 19 chat/workspace surfaces, both themes | These surfaces share the chat or its modal background. The bundled Coordinator visibly adds **Approvals unavailable / Retry**. The shared pending-action reader requires the authenticated response's `x-mikka-viewer`, while the native protocol dropped that header even on HTTP 200. | Preserve only the existing public `x-mikka-viewer` and `x-mikka-observed-at` headers. Keep credential, cookie and private cache headers filtered. The real shared reader continues rejecting missing or foreign viewer proof. |
| Light task (1.99228%) | Task fields had loaded, but the independent activity-version read had not rendered its creation event in the hosted capture. The bundled image already showed the fixture's “Created the task” row, moving the comment area and timestamp mask. | Wait for that existing fixture activity row in the task region before capture. No request, mock, fixed delay or retry click was added. |
| Offline, both themes (1.15702% / 1.15640%) | Hosted card bounds were x540–899; bundled x535–894. The bundled document retained a 10px application scrollbar gutter, moving the card 5px. Once aligned, icon/title/button/border regions were pixel-identical; only the status line differed. | Disable the root gutter only while `.desktop-offline` exists. Both surfaces now use the neutral waiting copy “Waiting for the connection to recover.” / “等待连接恢复。” Existing automatic recovery and manual retry behavior remain intact; no polling or backend read was added. |
| Light security (0.11929%) | The workspace mark was blue in hosted and pink in bundled; the last-active text also crossed a minute boundary. | Fix the common color compilation difference below. Keep the original timestamp visible and all mask rules unchanged. |

The color discrepancy affects the workspace mark across authenticated screens, including screens that were already below the comparison threshold. Both surfaces use the same `WorkspaceAvatar` class and palette; it is not an account-specific color.

The exact production CSS showed that the web compilation converts `oklch()` palette values to `lab()` before the existing `color-mix(in oklch, …)`. The desktop compilation omitted that pass. Its explicit zero-hue neutral made the same soft-blue token pink. Original image background samples were hosted RGB (215, 229, 254) and bundled RGB (248, 219, 234).

The desktop build now applies the **same installed Next native Lightning CSS engine and web browser targets after Tailwind**, before esbuild packages the CSS. This is a build-only dependency and adds no Next runtime to the renderer. The two themes' accent and neutral declarations match the actual hosted CSS values in a regression test. The direct Lightning CSS 1.30.1 available through the Tailwind chain yielded a small residual neutral chroma instead of Next's exact zero; it was not substituted as if byte-equivalent. Phase 2 should migrate this transform contract and regression when removing build-time Next dependencies.

A static count on the original light-security images found 844 changed pixels in the mark, 656 in the last-active line, and 46 elsewhere. Excluding the already identified mark difference leaves 702 pixels (0.05417%). This is a diagnostic count, **not a post-fix screenshot result** and not a new mask.

## Verification of the changes

- The added shared-reader-through-native-proxy regression first failed with `pendingActionsUnavailable`, matching the observed UI error.
- The color compilation regression first failed with the old `oklch()` output.
- After the changes, the focused protocol/security/shared-reader, palette, and offline-copy suite passed **25/25**.
- The offline-copy check exercises both languages, both failure reasons and the existing retry transition, and rejects an added display timer.
- Desktop production build, main and renderer TypeScript checks, strict focused lint, and `git diff --check` passed.
- The test compiles the real shared approval reader through the browser boundary so erased server model types do not become main-process dependencies.

These results verify the specific transport, compilation, and presentation changes. **No post-fix full native matrix has yet been recorded here.** Targeted native screenshots and the complete signed macOS acceptance run remain required. The 100 original comparisons retain their failed result.

