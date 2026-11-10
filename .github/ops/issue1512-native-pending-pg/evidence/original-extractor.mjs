function extractPendingOriginals(log, utilities) {
  const { base64decode, utf8decode, utf8, sha256bytes } = utilities
  const require = (condition, message) => { if (!condition) throw Error(message) }
  const files = [], markers = {}, keys = new Set()
  let active = null
  for (const rawLine of log.split(/\r?\n/)) {
    const index = rawLine.indexOf('ISSUE1512_NATIVE_PENDING_')
    if (index < 0) continue
    const prefix = rawLine.slice(0, index)
    if (prefix && !/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+$/.test(prefix)) continue
    const line = rawLine.slice(index + 'ISSUE1512_NATIVE_PENDING_'.length)
    const space = line.indexOf(' ')
    const type = space < 0 ? line : line.slice(0, space)
    const body = space < 0 ? '' : line.slice(space + 1)
    if (type === 'ORIGINAL_BEGIN') {
      require(active === null, 'Nested original output block')
      const meta = JSON.parse(body)
      const key = [meta.phase, meta.label, meta.stream].join(':')
      require(!keys.has(key), 'Duplicate original output block ' + key)
      require(['stdout', 'stderr'].includes(meta.stream), 'Unexpected stream')
      require(meta.file === meta.phase + '-' + meta.label + '-' + meta.stream + '.log', 'Unexpected output filename')
      require(Number.isInteger(meta.bytes) && meta.bytes >= 0 && /^[a-f0-9]{64}$/.test(meta.sha256), 'Malformed output declaration')
      active = { key, meta, chunks: [] }
    } else if (type === 'ORIGINAL_CHUNK') {
      require(active !== null, 'Orphan output chunk')
      require(/^[A-Za-z0-9+/]*={0,2}$/.test(body), 'Malformed base64 output chunk')
      active.chunks.push(body)
    } else if (type === 'ORIGINAL_END') {
      require(active !== null, 'Orphan output end')
      const end = JSON.parse(body)
      require([end.phase, end.label, end.stream].join(':') === active.key, 'Mismatched output end')
      const base64 = active.chunks.join('')
      const bytes = base64decode(base64)
      require(bytes.length === active.meta.bytes, 'Output length mismatch: ' + active.key)
      require(sha256bytes(bytes) === active.meta.sha256, 'Output SHA256 mismatch: ' + active.key)
      const text = utf8decode(bytes)
      require(sha256bytes(utf8(text)) === active.meta.sha256, 'Output is not losslessly representable as UTF-8')
      keys.add(active.key)
      files.push({ ...active.meta, text })
      active = null
    } else {
      if (!markers[type]) markers[type] = []
      markers[type].push(JSON.parse(body))
    }
  }
  require(active === null, 'Truncated output block')
  require(markers.VERDICT?.length === 1, 'Missing or duplicate final verdict')
  require(markers.CLEANUP?.length === 1, 'Missing or duplicate cleanup receipt')
  const receipt = markers.VERDICT[0]
  require(receipt.runId === '42745526739' && receipt.attempt === '1', 'Wrong run binding')
  for (const command of receipt.commands) for (const stream of ['stdout', 'stderr']) {
    const file = files.find(value => value.file === command[stream].file)
    require(file && file.bytes === command[stream].bytes && file.sha256 === command[stream].sha256, 'Command output is missing from final receipt')
  }
  require(files.length === receipt.commands.length * 2, 'Unexpected unbound output blocks')
  return { files, markers, receipt, cleanup: markers.CLEANUP[0] }
}
