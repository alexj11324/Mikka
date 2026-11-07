# Self-hosting visual evidence

This directory is a screenshot entry, not a product route or a browser functional test. The independent `Self-hosting UI evidence` GitHub job builds the real `CloudSettings`, `CloudModelSettings` and `GitHubAppSettings` with the existing production Vite configuration. It also exports the unchanged Expo Web application. It does not require a database, account, provider credential or deployment.

The capture serves those bundles on two runner-local origins. Its only API answers are explicitly synthetic GET records and a signed-out session. Non-GET requests and external browser traffic are rejected. The only interactions open existing dialogs or the mobile server choice/address form; no connect, save, revoke, sign-in or OAuth form is submitted. Chromium keeps its sandbox. The capture entry refuses to run outside GitHub Actions, including the local browser environment whose URL access is blocked.

The evidence contains one `index.html` gallery, PNGs, `evidence.json` and `build.json`. The manifest records the checked-out commit, runner origins, view paths, dimensions, themes, source inputs and asset hashes. The personal-revoked fixture deliberately keeps the team connected so the owner can review that it does not imply team billing. It includes both reconnect and explicit disconnect controls from the existing component. The manifest starts `reviewed: false`; successful screenshot creation is not an approval.

Only same-repository pull requests run this job. Its explicit `contents: write` permission and job-local `GITHUB_TOKEN` create a new `evidence/self-hosting-ui/<exact-head>-<run-id>` branch with an independent root commit containing only this run's gallery, manifests and PNGs. A README renders the images directly on GitHub. The publisher validates the source/head/run, allows only those files, refuses an existing branch and never updates a ref or writes the source branch or `main`. It writes immutable evidence-commit links in the job summary. This avoids dependence on Actions artifact storage quota; the job neither uploads a duplicate artifact nor deletes existing artifacts. No workflow is included in the evidence commit, and [GitHub does not trigger a new push workflow from the job's `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

Web shots cover empty/configured/revoked/error states, the disconnect and GitHub App creation dialogs, an English organization form, light/dark themes and a narrow revoked view. Expo shots cover the real signed-out screen, server choice and self-hosted address form at 375 and 430 pixels in both themes. Web shots isolate the existing settings content; they do not prove navigation through the whole authenticated shell. No component library or product UI is recreated here.

## Review and remaining acceptance

The PR owner opens the gallery and reviews the actual images using `docs/review-checklist.md`, then links the exact run/evidence commit and records findings on the PR. There is no accepted Figma frame for this change; the repository's existing components are the visual source. A CI green result means the bundles rendered and screenshots were produced, not that OAuth, scopes, billing, server discovery, push or native iOS flows worked.

After the OTA, Alex's TestFlight checklist remains separate:

- Open server selection, switch between Mikka Cloud and a self-hosted server, and enter the HTTPS address with its base path.
- Check safe areas, the native segmented control, Dynamic Type, light/dark appearance, keyboard visibility and dismiss/back behavior.
- Against the approved deployment, perform the real discovery and login flow; verify system-browser OAuth returns to the originating server/account.
- Switch saved accounts and confirm chats, models and credentials stay attached to the selected server.
- Check cloud model quota/refusal wording and the explicit billing link, then check notification routing on a real device.

These steps are not executed or claimed by this screenshot job.
