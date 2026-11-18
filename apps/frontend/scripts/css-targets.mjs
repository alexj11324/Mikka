// The browser targets the shared Tailwind + Lightning CSS pass compiles for.
//
// Frozen copy of Next's `modern-browserslist-target` ("baseline widely
// available", generated 2025-10-01), which the application used while Next was
// still a dependency. Regenerate with:
//
//   pnpm exec browserslist "baseline widely available"
//
// Version numbers use Lightning CSS's packed form: major << 16 | minor << 8 | patch.
const version = (major, minor = 0, patch = 0) => (major << 16) | (minor << 8) | patch

export const sharedCssTargets = Object.freeze({
  chrome: version(111),   // 7274496
  edge: version(111),     // 7274496
  firefox: version(111),  // 7274496
  safari: version(16, 4), // 1049600
})
