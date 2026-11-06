/**
 * A failed 添加这台电脑 reports the command's stderr as its reason. npm prints
 * deprecation and engine warnings before its real error, so the first line of
 * stderr is usually noise. These helpers find the lines a person should read;
 * the whole output stays available as the full log. Structured failure codes
 * come from the installer (#1517); until then this is the readable summary.
 */
const NOISE = [
  /^npm (?:warn|notice|WARN|verb|http|timing|info)\b/,
  /^\(node:\d+\) (?:\[[A-Z0-9]+\] )?\w*Warning:/,
  /^\(Use `node --trace-/,
  /\bdeprecated\b/i,
]

/** stderr without empty lines, npm warnings and Node deprecation notices. */
export function realErrorLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() && !NOISE.some(rule => rule.test(line.trim())))
}

/** npm's own error block without its prefix and log-file footer, else the first real lines. Empty when it is all noise. */
export function firstRealError(stderr: string, max = 3): string {
  const lines = realErrorLines(stderr)
  const npm = lines.filter(line => /^npm (?:error|ERR!)/.test(line))
    .map(line => line.replace(/^npm (?:error|ERR!)\s*/, '').trim())
    .filter(line => line && !/^(?:A complete log of this run|Log files were not written|You can rerun the command)/.test(line))
  return (npm.length ? npm : lines.map(line => line.trim())).slice(0, max).join('\n').slice(0, 600)
}
