import { build } from 'esbuild'
import { resolve } from 'node:path'
import { repository } from './application-plugin.mjs'

let sequence = 0
export async function browserModule(source, define = {}) {
  const result = await build({
    absWorkingDir: repository,
    stdin: { contents: source, loader: 'tsx', sourcefile: 'frontend-contract.tsx', resolveDir: repository },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023',
    tsconfig: resolve(repository, 'apps/frontend/tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}', ...define },
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#frontend-${++sequence}`)
}
