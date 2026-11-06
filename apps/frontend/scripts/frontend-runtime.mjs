import { resolve } from 'node:path'

/** The target's small runtime is evaluated before the shared application graph. */
export function frontendRuntimeSource(target, { development = false, frontend, renderer }) {
  if (!['web', 'desktop'].includes(target)) throw new Error('FRONTEND_TARGET_INVALID')
  const runtime = target === 'web'
    ? resolve(frontend, 'src/web/runtime.ts')
    : resolve(renderer, 'installed-startup.ts')
  return `${development ? 'globalThis[Symbol.for("openui.devtools.autoMount")] = true;\n' : ''}import ${JSON.stringify(runtime)};\n`
}
