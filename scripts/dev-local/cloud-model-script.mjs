// #2886 cloud-loop model choices. Only the LiteLLM fixture calls these rules;
// the native CLI and server still execute every tool, write and verification.
const reply = text => ({ content: [{ type: 'text', text }], finishReason: 'stop' })

export function cloudLocalModelAnswer(c) {
  const marker = /cloud-acceptance-[a-f0-9-]{36}/.exec(c.all)?.[0]
  if (!marker || !c.has('create_issue')) return null
  const created = c.results('create_issue', true).at(-1)
  if (!created) return c.call('create_issue', { title: marker,
    body: `在当前仓库写入文件 cloud-acceptance.txt，内容为 ${marker}。完成后用 submit 工具提交报告，不推送、不创建 PR。` })
  if (!created.id || created.error) return { status: 422, code: 'fixture_cloud_issue_not_created' }
  return reply(`Created ${created.id}; no run dispatched.`)
}

export function cloudNativeModelAnswer(c) {
  const marker = /cloud-acceptance-[a-f0-9-]{36}/.exec(c.all)?.[0]
  if (!marker || !c.has('submit')) return null
  if (c.results('submit', true).length) return reply('The real submit tool recorded the cloud fixture report.')
  if (!c.has('Bash')) return { status: 422, code: 'fixture_cloud_shell_missing' }
  const output = c.results('Bash', true).map(value => typeof value === 'string' ? value : JSON.stringify(value))
  if (!output.length) return c.call('Bash', { command: 'cat README.md && cat package.json', description: 'Read the actual task repository before changing its file' })
  const receipt = output.find(value => value.includes('CLOUD_FIXTURE_WRITTEN') && value.includes(marker))
  if (!receipt) return c.call('Bash', {
    command: `printf '%s\\n' '${marker}' > cloud-acceptance.txt && cat cloud-acceptance.txt && printf 'CLOUD_FIXTURE_WRITTEN\\n'`,
    description: 'Write and read back the requested cloud acceptance file',
  })
  return c.call('submit', { summary: `Wrote cloud-acceptance.txt and read its actual bytes: ${marker}.`,
    criteria: [{ text: `cloud-acceptance.txt contains ${marker}`, passed: true, evidence: receipt }] })
}
