const placeholder = /^(?:[-_*\s.[\]]*|tbd|todo|pending|n\/?a|none|not yet|待补充|待填写|待验收|<[^>]*>)$/i
const meaningful = value => typeof value === 'string' && !placeholder.test(value.trim())
const isUiFile = path => /^(?:components\/|app\/)/.test(path) &&
  !/^app\/(?:api|actions)\//.test(path) &&
  !/\.(?:test|spec)\.[^/]+$/.test(path) &&
  /\.(?:[jt]sx|css|scss|sass|less|svg)$/.test(path)

/** Extract the visible level-two Acceptance section; example headings in code
 * fences and HTML comments cannot manufacture an admission section. */
export function acceptanceSection(body = '') {
  const lines = String(body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)
  const sections = []
  let current = null
  let fence = null
  for (const line of lines) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (delimiter) {
      if (!fence) fence = delimiter[1]
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = null
      if (current) current.push(line)
      continue
    }
    const heading = !fence && line.match(/^ {0,3}(#{1,2})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      if (current) sections.push(current.join('\n'))
      current = heading[1] === '##' && /^Acceptance\s*:?$/i.test(heading[2]) ? [] : null
    } else if (current) current.push(line)
  }
  if (current) sections.push(current.join('\n'))
  return sections
}

function field(section, name) {
  const match = section.match(new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?${name}(?:\\*\\*)?[ \\t]*:[ \\t]*([^\\n]*)$`, 'im'))
  return match?.[1]?.trim() ?? ''
}

function withoutExamples(section) {
  let fence = null
  return section.split('\n').filter(line => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (delimiter) {
      if (!fence) fence = delimiter[1]
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = null
      return false
    }
    return !fence && !/^(?: {4}|\t)/.test(line)
  }).join('\n')
}

function hasImage(section) {
  // GitHub uploads usually have no filename extension. Only rendered Markdown
  // images, img tags, or explicit image-file links establish screenshot syntax.
  const visible = withoutExamples(section)
  return /!\[[^\]]*\]\(\s*https?:\/\/[^\s)]+(?:\s+["'][^"']*["'])?\s*\)/i.test(visible) ||
    /<img\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/i.test(visible) ||
    /https?:\/\/[^\s)<>]+\.(?:png|jpe?g|webp|gif)(?=[\s)<>?]|$)/i.test(visible)
}

/** Validate declared evidence, not whether that evidence proves the change.
 * Independent checker review owns the latter. No network or model is used. */
export function inspectAcceptance({ body, files = [], draft = false } = {}) {
  const uiFiles = [...new Set(files.flatMap(file => typeof file === 'string'
    ? [file] : [file.filename, file.previous_filename].filter(Boolean)).filter(isUiFile))]
  if (draft) return { status: 'draft', mode: null, errors: [], uiFiles }
  const sections = acceptanceSection(body)
  if (sections.length !== 1) return {
    status: 'fail', mode: null, errors: [sections.length ? 'acceptance.duplicate' : 'acceptance.missing'], uiFiles,
  }
  const section = withoutExamples(sections[0])
  const errors = []
  const notNeeded = section.match(/^[ \t]*(?:[-*][ \t]+)?Not needed[ \t]*:[ \t]*([^\n]*)/im)
  const productionOnly = section.match(/^[ \t]*(?:[-*][ \t]+)?Production only[ \t]*:[ \t]*([^\n]*)/im)
  const mode = notNeeded ? 'not-needed' : productionOnly ? 'production-only' : 'evidence'
  if (notNeeded && productionOnly) errors.push('acceptance.conflicting-modes')
  if (!meaningful(section)) errors.push('acceptance.placeholder')
  if (mode === 'not-needed') {
    if (!meaningful(notNeeded[1])) errors.push('acceptance.reason-missing')
  } else if (mode === 'production-only') {
    if (!meaningful(productionOnly[1])) errors.push('acceptance.reason-missing')
    if (!/\b(?:OAuth|GitHub App|Slack App|payment|push)\b|支付|推送/i.test(productionOnly[1])) {
      errors.push('acceptance.production-scope')
    }
    if (!meaningful(field(section, 'Owner'))) errors.push('acceptance.owner-missing')
    if (!meaningful(field(section, 'Internal account'))) errors.push('acceptance.internal-account-missing')
  } else {
    if (!/^(?:E2B|device|both|设备|都有)(?=$|[\s（(])/i.test(field(section, 'Runtime'))) errors.push('acceptance.runtime-missing')
    if (!/^(?:scripted|脚本化)(?=$|[\s（(])/i.test(field(section, 'Model'))) errors.push('acceptance.scripted-model-missing')
    if (!/^`?[a-f0-9]{40}`?$/i.test(field(section, 'Commit'))) errors.push('acceptance.commit-missing')
    if (!meaningful(field(section, 'Fixtures?'))) errors.push('acceptance.fixture-missing')
    const evidence = field(section, 'Evidence')
    const items = field(section, 'Items')
    const link = /https?:\/\/[^\s)>]+/i.test(evidence) || hasImage(section)
    const counts = items.match(/\b(\d+)\s*\/\s*(\d+)\s*(?:pass(?:ed)?|通过)/i)
    const summary = meaningful(items) && counts && Number(counts[1]) > 0 && Number(counts[1]) === Number(counts[2])
    if (!link && !summary) errors.push('acceptance.evidence-missing')
  }
  if (mode !== 'not-needed' && uiFiles.length && !hasImage(section)) errors.push('acceptance.screenshot-missing')
  return { status: errors.length ? 'fail' : 'pass', mode, errors, uiFiles }
}

export const acceptanceErrors = {
  'acceptance.missing': 'Add one ## Acceptance section to the PR body.',
  'acceptance.duplicate': 'Keep exactly one ## Acceptance section.',
  'acceptance.placeholder': 'Replace Acceptance placeholders with evidence or a reason.',
  'acceptance.conflicting-modes': 'Choose evidence, Not needed, or Production only.',
  'acceptance.reason-missing': 'Write a concrete reason after Not needed: or Production only:.',
  'acceptance.production-scope': 'Production only is for OAuth, app installation, payments, or push; explain that external dependency.',
  'acceptance.owner-missing': 'Production only needs Owner: with the acceptance owner.',
  'acceptance.internal-account-missing': 'Production only needs Internal account: with an authorized account alias, never credentials.',
  'acceptance.runtime-missing': 'Declare Runtime: E2B, device, or both.',
  'acceptance.scripted-model-missing': 'Declare Model: scripted (at the LiteLLM boundary).',
  'acceptance.commit-missing': 'Declare Commit: with the full tested Git SHA.',
  'acceptance.fixture-missing': 'Declare Fixtures: with the replay or scripted scenario names.',
  'acceptance.evidence-missing': 'Add Evidence: with a report link, a screenshot, or Items: with the item list and passed/total count.',
  'acceptance.screenshot-missing': 'UI changes need a screenshot image link in Acceptance, or Not needed: with a reason.',
}

export function acceptanceSummary(result) {
  if (result.status === 'draft') return 'Draft: acceptance is not evaluated; mark ready to run admission.'
  if (result.status === 'pass') return `Acceptance declaration passed (${result.mode}); evidence correctness remains an independent review.`
  return result.errors.map(code => `${code}: ${acceptanceErrors[code]}`).join('\n')
}
