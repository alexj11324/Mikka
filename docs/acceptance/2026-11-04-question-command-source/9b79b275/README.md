# PR #1250 — merged-head production-build UI evidence

## Exact application and execution

- Application commit: `9b79b2759e696dabbce0de6d3b587d7d86439e16`.
- Application tree: `e3d23f65de798d9b0caf6c1af90395f4fc6273b6`; merges the original #1250 implementation with main `2ab9649b14b75b530172bfe51933e4f3b51f949e`.
- Docker Cloud Sandbox, Node 24.22.2, pnpm 10.34.3, PostgreSQL 17.11.
- Fresh isolated local database `mikka_source_9b79b275_e2e`; immutable TestAccountPool environment `local-6a092451-7ec9-4be9-af3d-76acb91b2555`.
- Real production build completed with exit code 0. The app served at `http://localhost:3400`.
- Capture interval: 2026-11-04T18:54:33.542Z to 2026-11-04T18:54:48.403Z. The screenshot driver completed with exit code 0.
- The first setup attempt stopped before fetch/build/database creation because the unprivileged user could not create a task-specific directory under /home. Existing passwordless sudo created and assigned that directory; the next build succeeded. No application code or test guard changed.
- The previous `7486013` captures remain intact in the parent directory. This directory contains a new build, new database, and new captures for `9b79b275`.

## What was exercised

The driver used the normal TestAccountPool login and attestation, persisted a synthetic fixture in the isolated local PostgreSQL database, and opened the actual application in headful Chromium under Xvfb. It did not intercept API responses, invoke models, run a browser test suite, or touch production data.

The real task-detail request returned HTTP 200 for the owner and HTTP 404 for the peer. Both independent check rows exposed the expected source run `ab70c00f-5aed-4f53-8105-6ff7401eb759`, source session `local-before-question-session`, recovery event `d914d379-3b75-4d87-9bec-55284f09efb1`, and observation time `2026-11-04T12:03:04.000Z`.

The review remained **failed** and the verification remained **passed**. The added attribution did not change either verdict. Chinese and English layouts showed the source label, locale-formatted observation time, and normal source navigation control at 1440×960 and 390×844 in light and dark themes. The ninth capture follows a real click on “View execution” and shows the source execution marker “Local pre-question execution / 本地提问前执行记录”.

All nine captures were visually inspected after download. The source label and controls remained legible; the English mobile layout wrapped without clipping. Source navigation opened the expected execution. Downloaded PNG SHA-256 values matched the manifest. The local TestAccountPool lease was quarantined after use.

These are **local persisted fixture** results. They verify the server read path, authorization, UI projection, and navigation. They are not production acceptance or real native command provenance; the separate real PostgreSQL regression in #1250 covers provenance admission.

## Captures

| Image | View | SHA-256 |
| --- | --- | --- |
| [zh-source-1440-light.png](zh-source-1440-light.png) | zh-CN, 1440×960, light, attributed-failed-review | `6087b797a920dff16c011bbf2f7afbbf9c3a1f8d1dd358cd85655a1b2e54ee12` |
| [zh-source-1440-dark.png](zh-source-1440-dark.png) | zh-CN, 1440×960, dark, attributed-failed-review | `9f1fa791b3e839ebd452cbe14a9be17fba381cbc43b93f46e69ee21319308a71` |
| [zh-source-390-light.png](zh-source-390-light.png) | zh-CN, 390×844, light, attributed-failed-review | `3f5d468b60caa181dd745725ca207118108da89e6307c6777c1c1f0d16a001f4` |
| [zh-source-390-dark.png](zh-source-390-dark.png) | zh-CN, 390×844, dark, attributed-failed-review | `9da8d6c8888916ea6cf665f04190e0c53d3de660f86b3e6e873ce2dd573c710f` |
| [en-source-1440-light.png](en-source-1440-light.png) | en, 1440×960, light, attributed-failed-review | `c4e2d9c03be26a7ba878078b46541f4845294740fc2ab0effd80517712e33559` |
| [en-source-1440-dark.png](en-source-1440-dark.png) | en, 1440×960, dark, attributed-failed-review | `13c81b83f80736c8ece7018c1a5d15b64d8e80b8b6a6062e47cff54d137fd259` |
| [en-source-390-light.png](en-source-390-light.png) | en, 390×844, light, attributed-failed-review | `bf906e021606b4aad274e1304ba0aa4d2be39c9ebf8537e6049e3e570a91742e` |
| [en-source-390-dark.png](en-source-390-dark.png) | en, 390×844, dark, attributed-failed-review | `566819bc22c3dc718e7e46741ed47c1131fa9e60564c91df9e41014656057c93` |
| [en-source-thread-390-dark.png](en-source-thread-390-dark.png) | en, 390×844, dark, source-thread | `d4020161591414ace2b47bad811b5a24bfbdd59ea1b0301c61ff4058be08fcbe` |

## Reproduction records

- [Manifest](manifest.json) records the exact commit, environment, synthetic fixture IDs, HTTP results, source navigation, capture times, and hashes.
- [Screenshot driver](../capture.mjs), unchanged: SHA-256 `967cf79a51c614e0b1acccb3e8505871386f33430c12ab62747383d22e57a905`.
- [Runtime launcher](../runtime.mjs), unchanged: SHA-256 `e15578188addeff5f3dca5649deb1ce65d1009bc8e04f470e5911f52e1742776`.
- Credentials, cookies, session tokens, and browser traces are not included.
