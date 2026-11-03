# Report/deliverable acceptance

Source: `09dbaa1f46782a9c4568ef973a5b8d42d118df50`. Cloud Linux, Node 24, real ApprovalBar/component library and project CSS, built with `next build --webpack` and served with `next start` on loopback port 3217. The isolated presentational preview supplies three fixture states; it does not simulate an authenticated task or establish backend acceptance. No browser tests were run. Screenshots: 1000px light/dark and 390px light.

| Person's task | Before | After |
| --- | --- | --- |
| Accept an independently checked report or desktop deliverable | Requires a PR/commit and cannot finish | 验收 invokes the existing human action with a non-repository candidate |
| Recognize that the report was accepted | No supported state | 已验收 with the existing completed-state icon |
| Accept a code change | 验收并合并 and exact commit | Same action, label and commit identity |
| Return either candidate for changes | Existing 退回修改 | Remains reachable |

Reviewed R-40/R-56, component reuse, states, empty metadata, permission/evidence gating in the parent, button labels/keyboard semantics and narrow width. No new dialog, subtitle, tooltip policy, chat quote or copy behavior. Reports have no invented SHA or GitHub action. No usability finding at severity 3 or 4 in these changed controls. Light/dark/mobile screenshots show the changed states together; surrounding app navigation is outside this presentational capture.

Backend behavior is verified separately by the real PostgreSQL cloud/desktop flow, including independent stages, browser-session-bound acceptance and no GitHub calls for a deliverable. Repository merge and tenant/session fences retain their own database suites.
