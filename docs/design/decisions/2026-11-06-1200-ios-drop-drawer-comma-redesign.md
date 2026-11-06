# iOS: drop the push drawer, redesign after Comma's iOS app

- Date: 2026-11-06
- Source: Alex, relayed by the coordinator on 2026-11-06: the drawer version (#1408, #1446, #1453) does not look good;
  no drawer. Redesign the mobile app after Comma's mobile app, which he considers in line with Apple's current design
  guidelines; where Comma and the HIG differ, the HIG wins.
- Rule: —
- Replaces: [2026-11-05-2005](2026-11-05-2005-ios-push-drawer.md) (one Stack in a push drawer) and its refinement
  [2026-11-05-2205](2026-11-05-2205-drawer-native-surface.md).

- No drawer. The proposed structure (system tab bar 对话 · 线程 · 建议 · 设置, a search tab at the trailing end) is
  drawn in [`mobile-comma-redesign.md`](../mobile-comma-redesign.md) and is a draft until Alex accepts the frames.
- Implementation waits for Alex's review of those frames. Until then the drawer build stays on `main`.
