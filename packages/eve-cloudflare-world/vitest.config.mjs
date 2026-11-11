import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The upstream suite imports Vitest from its own package. Resolve its collector
  // through the active runner even when pnpm installs multiple peer variants.
  resolve: { dedupe: ['vitest'] },
  test: { server: { deps: { inline: ['@workflow/world'] } } },
})
