// 决定 `pnpm build` 里的 scripts/migrate.mjs 要不要真的执行迁移。
// 本地构建默认跳过，避免把功能分支的迁移打到共享的 dev-local 库上。
// 只有以下情况才执行：
// - 显式设置 MIKKA_RUN_MIGRATIONS=1（MIGRATE=1 是旧名字，继续认）；
// - 在 Vercel 上构建（VERCEL=1）且是生产环境（VERCEL_ENV=production）。
//   Preview 构建和以前一样跳过；只有 VERCEL_ENV=production 而没有 VERCEL=1（比如本地 pull 下来的 env）也跳过。
export function migrationGate(env) {
  if (env.MIKKA_RUN_MIGRATIONS === '1') return { run: true, reason: 'MIKKA_RUN_MIGRATIONS=1' }
  if (env.MIGRATE === '1') return { run: true, reason: 'MIGRATE=1 (legacy)' }
  if (env.VERCEL === '1' && env.VERCEL_ENV === 'production') return { run: true, reason: 'Vercel production build' }
  return { run: false, reason: 'not a Vercel production build; set MIKKA_RUN_MIGRATIONS=1 to run' }
}
