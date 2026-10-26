// Validate retained Go evidence before converting it to the Node runner's TAP contract.
export function retainedGoPattern(contract) {
  const names = contract.retainedTests
  if (!Array.isArray(names) || names.length !== contract.retainedCount || !names.length ||
      new Set(names).size !== names.length || names.some(name => !/^Test[A-Za-z0-9_]+$/.test(name))) {
    throw new Error('Invalid retained Go test contract')
  }
  const excluded = [...contract.pendingTests.map(item => item.name), ...contract.separateApplicationIntegration]
  if (names.some(name => excluded.includes(name))) throw new Error('Retained Go contract overlaps pending tests')
  return `^(${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
}

export function retainedGoTap(raw, contract) {
  retainedGoPattern(contract)
  const expected = new Set(contract.retainedTests)
  const started = new Set(), passed = new Set()
  const packageName = 'github.com/alexj11324/Mikka/subscription-worker'
  let packagePasses = 0
  for (const line of raw.split('\n').filter(line => line.trim())) {
    let event
    try { event = JSON.parse(line) } catch { throw new Error('Invalid retained Go JSON evidence') }
    if (!event || event.Package !== packageName || ['fail', 'skip'].includes(event.Action)) {
      throw new Error('Retained Go evidence contains failure, skip or unexpected package')
    }
    if (event.Test !== undefined) {
      if (typeof event.Test !== 'string' || !expected.has(event.Test.split('/')[0])) {
        throw new Error('Retained Go evidence contains an unapproved test')
      }
      if (!event.Test.includes('/')) {
        if (event.Action === 'run') {
          if (started.has(event.Test)) throw new Error('Duplicate retained Go test execution')
          started.add(event.Test)
        }
        if (event.Action === 'pass') {
          if (!started.has(event.Test) || passed.has(event.Test)) throw new Error('Invalid retained Go test completion')
          passed.add(event.Test)
        }
      }
    } else if (event.Action === 'pass') packagePasses++
  }
  if (packagePasses !== 1 || started.size !== expected.size || passed.size !== expected.size) {
    throw new Error('Incomplete retained Go evidence')
  }
  return ['TAP version 13', ...contract.retainedTests.map((name, i) => `ok ${i + 1} - ${name}`),
    `1..${expected.size}`, `# tests ${expected.size}`, `# pass ${expected.size}`,
    '# fail 0', '# skipped 0', '# todo 0', '# cancelled 0'].join('\n')
}
