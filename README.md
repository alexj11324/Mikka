# Policy entries review for PR 1693

Policy source `4ec411d5d90b341aa65e58409f262af4a6d0734c` is compared with baseline `facb389f6cc06c453e9135bb60ada1b0f302e0d9`. Both runs used production backend `facb389f6cc06c453e9135bb60ada1b0f302e0d9`.

The frozen Expo Web exports were served privately in Chromium at the app origin. Only preview page HTML and Expo assets were fulfilled from those exports. Authentication and `/mikka/api/` requests used the real production network and the dedicated review account through normal email sign-in. All recorded API responses returned HTTP 200. The account email is masked.

Observed actions opened `https://aspectlylabs.com/privacy` from sign-in and Settings, and `https://app.aspectlylabs.com/mikka/settings?section=account` from Profile. The web confirmation was left untouched.

The controls are reachable through the existing scroll views at both widths and appearances. The 2x cases simulate browser text size. Native Dynamic Type, browser launch and signed handoff remain unverified. Portrait and iPhone widths match the app configuration. Tablet and landscape are unsupported.

These engineering captures preserve the policy commit locale. Final English store assets belong to the combined release source.

[After manifest](4ec411d5/manifest.json) · [Baseline manifest](basefacb/manifest.json) · [Capture script](capture.mjs)

## Screenshot comparisons

### Signin

| Width | Appearance | Text | Baseline | Policy entries |
| --- | --- | --- | --- | --- |
| 320 | light | 1x | ![Baseline signin 320 light 1x](basefacb/signin-320-light-1x.png) | ![Policy signin 320 light 1x](4ec411d5/signin-320-light-1x.png) |
| 320 | light | 2x | ![Baseline signin 320 light 2x](basefacb/signin-320-light-2x.png) | ![Policy signin 320 light 2x](4ec411d5/signin-320-light-2x.png) |
| 320 | dark | 1x | ![Baseline signin 320 dark 1x](basefacb/signin-320-dark-1x.png) | ![Policy signin 320 dark 1x](4ec411d5/signin-320-dark-1x.png) |
| 320 | dark | 2x | ![Baseline signin 320 dark 2x](basefacb/signin-320-dark-2x.png) | ![Policy signin 320 dark 2x](4ec411d5/signin-320-dark-2x.png) |
| 390 | light | 1x | ![Baseline signin 390 light 1x](basefacb/signin-390-light-1x.png) | ![Policy signin 390 light 1x](4ec411d5/signin-390-light-1x.png) |
| 390 | light | 2x | ![Baseline signin 390 light 2x](basefacb/signin-390-light-2x.png) | ![Policy signin 390 light 2x](4ec411d5/signin-390-light-2x.png) |
| 390 | dark | 1x | ![Baseline signin 390 dark 1x](basefacb/signin-390-dark-1x.png) | ![Policy signin 390 dark 1x](4ec411d5/signin-390-dark-1x.png) |
| 390 | dark | 2x | ![Baseline signin 390 dark 2x](basefacb/signin-390-dark-2x.png) | ![Policy signin 390 dark 2x](4ec411d5/signin-390-dark-2x.png) |

### Settings

| Width | Appearance | Text | Baseline | Policy entries |
| --- | --- | --- | --- | --- |
| 320 | light | 1x | ![Baseline settings 320 light 1x](basefacb/settings-320-light-1x.png) | ![Policy settings 320 light 1x](4ec411d5/settings-320-light-1x.png) |
| 320 | light | 2x | ![Baseline settings 320 light 2x](basefacb/settings-320-light-2x.png) | ![Policy settings 320 light 2x](4ec411d5/settings-320-light-2x.png) |
| 320 | dark | 1x | ![Baseline settings 320 dark 1x](basefacb/settings-320-dark-1x.png) | ![Policy settings 320 dark 1x](4ec411d5/settings-320-dark-1x.png) |
| 320 | dark | 2x | ![Baseline settings 320 dark 2x](basefacb/settings-320-dark-2x.png) | ![Policy settings 320 dark 2x](4ec411d5/settings-320-dark-2x.png) |
| 390 | light | 1x | ![Baseline settings 390 light 1x](basefacb/settings-390-light-1x.png) | ![Policy settings 390 light 1x](4ec411d5/settings-390-light-1x.png) |
| 390 | light | 2x | ![Baseline settings 390 light 2x](basefacb/settings-390-light-2x.png) | ![Policy settings 390 light 2x](4ec411d5/settings-390-light-2x.png) |
| 390 | dark | 1x | ![Baseline settings 390 dark 1x](basefacb/settings-390-dark-1x.png) | ![Policy settings 390 dark 1x](4ec411d5/settings-390-dark-1x.png) |
| 390 | dark | 2x | ![Baseline settings 390 dark 2x](basefacb/settings-390-dark-2x.png) | ![Policy settings 390 dark 2x](4ec411d5/settings-390-dark-2x.png) |

### Profile

| Width | Appearance | Text | Baseline | Policy entries |
| --- | --- | --- | --- | --- |
| 320 | light | 1x | ![Baseline profile 320 light 1x](basefacb/profile-320-light-1x.png) | ![Policy profile 320 light 1x](4ec411d5/profile-320-light-1x.png) |
| 320 | light | 2x | ![Baseline profile 320 light 2x](basefacb/profile-320-light-2x.png) | ![Policy profile 320 light 2x](4ec411d5/profile-320-light-2x.png) |
| 320 | dark | 1x | ![Baseline profile 320 dark 1x](basefacb/profile-320-dark-1x.png) | ![Policy profile 320 dark 1x](4ec411d5/profile-320-dark-1x.png) |
| 320 | dark | 2x | ![Baseline profile 320 dark 2x](basefacb/profile-320-dark-2x.png) | ![Policy profile 320 dark 2x](4ec411d5/profile-320-dark-2x.png) |
| 390 | light | 1x | ![Baseline profile 390 light 1x](basefacb/profile-390-light-1x.png) | ![Policy profile 390 light 1x](4ec411d5/profile-390-light-1x.png) |
| 390 | light | 2x | ![Baseline profile 390 light 2x](basefacb/profile-390-light-2x.png) | ![Policy profile 390 light 2x](4ec411d5/profile-390-light-2x.png) |
| 390 | dark | 1x | ![Baseline profile 390 dark 1x](basefacb/profile-390-dark-1x.png) | ![Policy profile 390 dark 1x](4ec411d5/profile-390-dark-1x.png) |
| 390 | dark | 2x | ![Baseline profile 390 dark 2x](basefacb/profile-390-dark-2x.png) | ![Policy profile 390 dark 2x](4ec411d5/profile-390-dark-2x.png) |

## Live web deletion entry

A supplemental read-only run used the same policy preview source against backend `9bcdefc5fe0c047393d581eea867ffa801f53dbe`. The opened official web account page rendered its Delete account control. The run stopped before opening or submitting deletion confirmation.

[Supplemental manifest](account-confirmation/manifest.json) · [Capture script](account-confirmation/capture.mjs)

![Official web account page with review-account email masked](account-confirmation/web-account-entry.png)
