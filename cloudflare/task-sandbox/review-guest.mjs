// Only the operator-built native image contains these immutable root programs.
// The shared API and user processes never supply a command or a guest path.
export async function prepareReviewGuest(container) {
  const guard = await container.exec([
    '/usr/bin/python3', '-I', '/opt/mikka/runtime/ingress-v1/guard.py', 'prepare-cloudflare',
  ], { user: '0:0' })
  const { exitCode, stdout } = await guard.output()
  if (exitCode !== 0 || stdout.byteLength > 4096) throw Error('Task review ingress unavailable')
  const proof = JSON.parse(new TextDecoder().decode(stdout))
  if (proof.ok !== true || proof.version !== 1 || proof.provider !== 'cloudflare' ||
      !Array.isArray(proof.providerPorts) || proof.providerPorts.length !== 0 ||
      proof.preparedBeforeWorker !== true || proof.rulesVerified?.ipv4 !== true || proof.rulesVerified?.ipv6 !== true ||
      !Number.isSafeInteger(proof.installedTicks) || proof.installedTicks < 0 ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(proof.bootId) ||
      !/^[a-f0-9]{64}$/.test(proof.sourceSha256)) throw Error('Task review ingress unavailable')

  const install = await container.exec([
    '/usr/bin/python3', '-I', '/opt/mikka/task-sandbox/workspace-control-install.py', '--cloudflare-task',
  ], { user: '0:0' })
  if ((await install.output()).exitCode !== 0) throw Error('Task workspace control unavailable')
  return { bootId: proof.bootId, sourceSha256: proof.sourceSha256 }
}

const witnessPath = '/opt/mikka/task-sandbox/review-checkpoint.py'

export async function captureReviewExit(container, runId) {
  const process = await container.exec(['/usr/bin/python3', '-I', witnessPath, 'capture', runId], {user:'0:0'})
  const {exitCode, stdout} = await process.output()
  if (exitCode !== 0 || stdout.byteLength > 8192) return null
  const witness = JSON.parse(new TextDecoder().decode(stdout))
  return witness?.runId === runId ? witness : null
}
export async function restoreReviewExit(container, witness) {
  const proc = await container.exec(['/usr/bin/python3', '-I', witnessPath, 'restore', witness.runId], {
    user:'0:0', stdin:new Response(JSON.stringify(witness)).body,
  })
  if ((await proc.output()).exitCode !== 0) throw Error('Original task review checkout unavailable')
}
