import { spawn } from 'node:child_process'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Keep all normal lifecycle scripts. ffmpeg-static exits early when its binary
// exists, even if an earlier metadata download failed, so pnpm retry alone can
// report success with a missing LICENSE. Only repair this known package failure.
export function runProcess(command, args, options) {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] })
    let output = ''
    const forward = stream => chunk => {
      stream.write(chunk)
      output = (output + chunk).slice(-65536)
    }
    child.stdout.on('data', forward(process.stdout))
    child.stderr.on('data', forward(process.stderr))
    child.once('error', reject)
    child.once('close', code => fulfill({ code: code ?? 1, output }))
  })
}

const transient = output => /(?:statusCode:\s*|HTTP(?:Error)?[: ]+)(?:502|503|504)\b/.test(output)
async function complete(files) {
  for (const file of files) {
    try {
      const value = await lstat(file)
      if (!value.isFile() || !value.size) return false
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return false
    }
  }
  return true
}

export async function installWorkspace({ cwd = process.cwd(), env = process.env, run = runProcess, packageJson } = {}) {
  const options = { cwd, env }
  const initial = await run('pnpm', ['install', '--frozen-lockfile'], options)
  const failedDownload = initial.code !== 0 && /ffmpeg-static/.test(initial.output) && transient(initial.output)
  if (initial.code !== 0 && !failedDownload) return initial.code
  // The upstream explicit binary override belongs to the operator, never to us.
  if (env.FFMPEG_BIN) return initial.code
  const manifest = packageJson ?? createRequire(join(cwd, 'package.json')).resolve('ffmpeg-static/package.json')
  const pkg = JSON.parse(await readFile(manifest, 'utf8'))
  if (pkg.name !== 'ffmpeg-static' || pkg.version !== '5.3.0') throw Error('unsupportedFfmpegInstaller')
  const directory = dirname(manifest)
  const binary = join(directory, (env.npm_config_platform || process.platform) === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const files = [binary, binary + '.README', binary + '.LICENSE']
  if (failedDownload || !await complete(files)) {
    const attempts = failedDownload ? 2 : 3 // Three upstream attempts including the original failure.
    let repaired = false
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Exact package-owned generated files only. unlink does not follow links;
      // directories or other filesystem errors fail instead of recursive removal.
      for (const file of files) {
        try { await unlink(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      console.log(`Repair ffmpeg-static download (${attempt + 1}/${attempts})`)
      const result = await run(process.execPath, [join(directory, 'install.js')], options)
      if (result.code === 0) {
        repaired = await complete(files)
        break
      }
      if (!transient(result.output)) return result.code
    }
    if (!repaired) return 1
  }
  if (initial.code !== 0) {
    // pnpm may have stopped before other packages' lifecycle scripts completed.
    const result = await run('pnpm', ['install', '--frozen-lockfile'], options)
    if (result.code !== 0) return result.code
  }
  return await complete(files) ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await installWorkspace()
}
