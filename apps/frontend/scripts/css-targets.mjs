// The browser targets the shared Tailwind + Lightning CSS pass compiles for.
//
// Snapshot of Next's `modern-browserslist-target` ("baseline widely available",
// generated 2025-10-01), which the application used while Next was still a
// dependency. This file is frozen on purpose: `pnpm exec browserslist "baseline
// widely available"` returns a newer set today, so re-running it would silently
// raise the floor and change the emitted CSS. Compare build output before
// changing these numbers.
//
// Version numbers use Lightning CSS's packed form: major << 16 | minor << 8 | patch.
const version = (major, minor = 0, patch = 0) => (major << 16) | (minor << 8) | patch

export const sharedCssTargets = Object.freeze({
  chrome: version(111),   // 7274496
  edge: version(111),     // 7274496
  firefox: version(111),  // 7274496
  safari: version(16, 4), // 1049600
})
