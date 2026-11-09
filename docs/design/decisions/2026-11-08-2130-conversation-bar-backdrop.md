# iOS conversation screens: a glass backdrop behind the bar once content scrolls under it

- Date: 2026-11-08
- Source: Alex on TestFlight (screenshot of a task's conversation, 「…Codex 完整验收…」 / 「Codex」), relayed by the coordinator: the bar had no background, and the title, the back pill and the messages overlapped.
- Rule: `apps/mobile/components/BarBackdrop.tsx` (`BarBackdrop`, `useScrolledUnderBar`), `NavBar`'s `scrolled`; `scrolledUnderBar` in `apps/mobile/components/nav-bar-options.ts`
- Amends: [0120](2026-11-08-0120-ios-header-like-comma.md) for screens whose conversation scrolls under the bar

On a bot chat, a group chat, a task, a task's conversation and a thread, the bar gets a material backdrop once content has scrolled under it: the system's Liquid Glass on iOS 26, the page colour under Reduce Transparency and before 26, with a short fade from the page colour below it so words dissolve before the bar. At rest, with nothing under it, the bar stays the page itself, as 0120 says. The bar's own items stay the system's: the glass back pill, the centred title, the buttons on the right. Other screens keep 0120's bar with the system's soft scroll edge (iOS 26) or TopFade (before 26).
