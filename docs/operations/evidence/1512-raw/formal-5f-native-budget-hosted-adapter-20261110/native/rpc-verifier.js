function verifyRpcReports(lifecycle) {
  const result = { schemaVersion: 2, errors: [], coverage: [], windows: {}, rowsChecked: 0, segmentRowsChecked: 0 }
  const equality = (actual, expected, label) => { if (actual !== expected) result.errors.push({ label, actual, expected }) }
  const problem = (condition, label) => { if (!condition) result.errors.push({ label }) }
  const fields = ['startedInWindow', 'completedInWindow', 'crossesStart', 'crossesEnd', 'completionNotObserved', 'completionWithoutStart']
  const key = row => row.route + '|' + (row.rpcAction ?? '')
  const checkRows = (rows, label, segment) => {
    const indexed = new Map(), total = Object.fromEntries(fields.map(field => [field, 0]))
    for (const row of rows) {
      problem(!indexed.has(key(row)), label + '.duplicate action')
      indexed.set(key(row), row)
      for (const field of fields) { problem(Number.isSafeInteger(row[field]) && row[field] >= 0, label + '.' + field + '.integer'); total[field] += row[field] }
      const statuses = new Set()
      let completedStatuses = 0
      for (const status of row.statusCounts) {
        problem(Number.isSafeInteger(status.status) && status.status >= 100 && status.status <= 599, label + '.status')
        problem(Number.isSafeInteger(status.count) && status.count >= 0 && !statuses.has(status.status), label + '.status count')
        statuses.add(status.status); completedStatuses += status.count
      }
      equality(completedStatuses, row.completedInWindow + row.crossesEnd, label + '.observed completion statuses')
      problem(row.crossesStart <= completedStatuses, label + '.confirmed carried in')
      problem(row.crossesEnd <= row.startedInWindow + row.crossesStart, label + '.confirmed carried out')
      problem(row.completionWithoutStart <= row.completedInWindow, label + '.orphan completion interval')
      const startedWithoutObservedCompletion = row.startedInWindow + row.crossesStart + row.completionWithoutStart - completedStatuses
      problem(startedWithoutObservedCompletion >= 0 && startedWithoutObservedCompletion <= row.completionNotObserved, label + '.unpaired starts preserved')
      if (segment) result.segmentRowsChecked++; else result.rowsChecked++
    }
    return { indexed, total }
  }
  const counts = lifecycle.queryCounts, physical = counts.rpcActions, logical = physical.logical
  for (const [kind, report] of [['physical', physical], ['logical', logical]]) {
    for (const [name, sql] of Object.entries(counts.windows)) {
      const value = report?.windows?.[name], label = kind + '.' + name
      if (!value || !Array.isArray(value.actions) || !Array.isArray(value.segments)) {
        result.coverage.push({ kind, name, available: false, status: value?.status ?? 'missing' })
        continue
      }
      result.coverage.push({ kind, name, available: true, status: value.status, segmentStatus: value.segmentStatus })
      equality(value.startedAt, sql.total.startedAt, label + '.start')
      equality(value.finishedAt, sql.total.finishedAt, label + '.finish')
      equality(value.segments.length, sql.segments.length, label + '.phase count')
      const whole = checkRows(value.actions, label, false), phaseRows = []
      for (let index = 0; index < value.segments.length; index++) {
        const segment = value.segments[index], expected = sql.segments[index]
        equality(segment.phase, expected.phase, label + '.phase' + index)
        equality(segment.startedAt, expected.startedAt, label + '.phase start' + index)
        equality(segment.finishedAt, expected.finishedAt, label + '.phase finish' + index)
        phaseRows.push(checkRows(segment.actions, label + '.' + segment.phase, true))
      }
      // Starts, in-window completions and completions without a start each
      // belong to exactly one half-open phase. Crossings, unknown completions
      // and statusCounts deliberately remain non-additive observations.
      for (const [index, phase] of phaseRows.entries()) for (const actionKey of phase.indexed.keys()) {
        problem(whole.indexed.has(actionKey), label + '.phase' + index + '.action exists in whole interval')
      }
      const actionKeys = new Set([...whole.indexed.keys(), ...phaseRows.flatMap(value => [...value.indexed.keys()])])
      for (const actionKey of actionKeys) for (const field of ['startedInWindow', 'completedInWindow', 'completionWithoutStart']) {
        equality(phaseRows.reduce((sum, phase) => sum + (phase.indexed.get(actionKey)?.[field] ?? 0), 0),
          whole.indexed.get(actionKey)?.[field] ?? 0, label + '.' + actionKey + '.' + field + '.phase sum')
      }
      if (kind === 'logical') {
        problem(value.actions.every(row => row.rpcAction !== 'desktop.readBatch'), label + '.batch envelope excluded from logical actions')
        for (const [index, phase] of value.segments.entries()) problem(phase.actions.every(row => row.rpcAction !== 'desktop.readBatch'), label + '.phase' + index + '.batch envelope excluded')
      }
      result.windows[label] = { status: value.status, segmentStatus: value.segmentStatus, totals: whole.total,
        segments: value.segments.map((segment, index) => ({ phase: segment.phase, totals: phaseRows[index].total })) }
    }
  }
  result.allEightProjectionsAvailable = result.coverage.length === 8 && result.coverage.every(row => row.available)
  result.allEightProjectionsComplete = result.allEightProjectionsAvailable && result.coverage.every(row => row.status === 'complete' && row.segmentStatus === 'complete')
  result.limitations = ['Checks exported projection arithmetic and phase boundaries only; does not replay unexported original RPC receipts.', 'Crossings, missing completions and status observations are preserved and are not additive request totals.']
  return result
}
