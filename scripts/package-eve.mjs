import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const publicPrefix = '/mikka/api/agents'
const functionPrefix = '_mikka_eve'

/** Preserve the public upstream output contract, including queue triggers.
 * The app and eve use separate function names, URLs and Workflow queues. */
export function eveVercelRoutes() {
  return [
    { src: '^/mikka/api/agents/(.*)$', dest: `/${functionPrefix}/__server` },
    { src: '^/mikka/api/webhooks/slack/?$', dest: `/${functionPrefix}/__server` },
  ]
}

export function eveFunctionWrapper(handler) {
  if (!/^[A-Za-z0-9_./-]+\.mjs$/.test(handler) || handler.split('/').includes('..')) throw new Error('EVE_FUNCTION_HANDLER_INVALID')
  return `const application = (await import(${JSON.stringify(`./${handler}`)})).default
export default { ...application, fetch(request, context) {
  const url = new URL(request.url)
  if (url.pathname === '/mikka/api/webhooks/slack' || url.pathname === '/mikka/api/webhooks/slack/') url.pathname = '/eve/v1/slack'
  else if (url.pathname.startsWith('${publicPrefix}/')) url.pathname = url.pathname.slice(${publicPrefix.length})
  else if (url.pathname.startsWith('/${functionPrefix}/')) url.pathname = url.pathname.slice(${functionPrefix.length + 1})
  const forwarded = new Request(url, request)
  return application.fetch(forwarded, context)
} }
`
}

export async function packageEve({ root = process.cwd(), preset = process.env.NITRO_PRESET || (process.env.VERCEL ? 'vercel' : 'node-server') } = {}) {
  if (!['node-server', 'vercel'].includes(preset)) throw new Error('EVE_BUILD_PRESET_INVALID')
  const source = join(root, 'apps/eve', preset === 'vercel' ? '.vercel/output' : '.output')
  const output = join(root, preset === 'vercel' ? '.vercel/output' : '.output')
  const agent = JSON.parse(await readFile(join(source, 'mikka-eve-build.json'), 'utf8'))
  const appPath = join(output, 'mikka-build.json')
  const app = JSON.parse(await readFile(appPath, 'utf8'))
  if (agent.version !== 1 || agent.eve !== '1.0.0-rc.9' || agent.revision !== app.revision || agent.preset !== preset) throw new Error('EVE_APP_BUILD_MISMATCH')
  let resourceRoot = output
  if (preset === 'node-server') {
    await cp(source, join(output, 'eve'), { recursive: true })
    for (const resource of app.resources) {
      const destination = join(output, 'eve', resource.path)
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(resourceRoot, resource.path), destination)
    }
  } else {
    const configPath = join(output, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const eve = JSON.parse(await readFile(join(source, 'config.json'), 'utf8'))
    if (eve.version !== 3 || config.version !== 3 || !Array.isArray(config.routes)) throw new Error('EVE_VERCEL_OUTPUT_INVALID')
    if (config.routes.some(route => route.dest?.startsWith(`/${functionPrefix}/`))) throw new Error('EVE_VERCEL_OUTPUT_ALREADY_PACKAGED')
    resourceRoot = join(output, app.functions[0].path)
    const functions = []
    const visit = async directory => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name)
        if (item.name.endsWith('.func')) {
          if (!(await lstat(path)).isDirectory()) throw new Error('EVE_FUNCTION_DIRECTORY_INVALID')
          functions.push(path)
        } else if (item.isDirectory()) await visit(path)
      }
    }
    const sourceFunctions = join(source, 'functions')
    await visit(sourceFunctions)
    for (const path of functions) {
      const target = join(output, 'functions', functionPrefix, relative(sourceFunctions, path))
      await mkdir(dirname(target), { recursive: true })
      await cp(path, target, { recursive: true })
      const functionConfigPath = join(target, '.vc-config.json')
      const functionConfig = JSON.parse(await readFile(functionConfigPath, 'utf8'))
      if (functionConfig.runtime !== 'nodejs24.x') throw new Error('EVE_FUNCTION_RUNTIME_INVALID')
      await writeFile(join(target, 'mikka-eve-entry.mjs'), eveFunctionWrapper(functionConfig.handler))
      const contract = { ...functionConfig, handler: 'mikka-eve-entry.mjs', supportsCancellation: true,
        environment: { ...functionConfig.environment, EVE_PUBLIC_ROUTE_PREFIX: publicPrefix } }
      await writeFile(functionConfigPath, `${JSON.stringify(contract, null, 2)}\n`)
      for (const resource of app.resources) {
        const destination = join(target, resource.path)
        await mkdir(dirname(destination), { recursive: true })
        await cp(join(resourceRoot, resource.path), destination)
      }
      app.functions.push({ path: relative(output, target), ...contract })
    }
    config.routes.unshift(...eveVercelRoutes())
    // Queue routes are invoked by the preserved trigger, not by the app's
    // root /.well-known/workflow routes. Cron URLs use the public eve mount.
    if (eve.crons?.length) config.crons = [...config.crons ?? [], ...eve.crons.map(cron => ({ ...cron,
      path: cron.path.startsWith(`${publicPrefix}/`) ? cron.path : `${publicPrefix}${cron.path}` }))]
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
  app.eve = agent
  await writeFile(appPath, `${JSON.stringify(app, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageEve()
