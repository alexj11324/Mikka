import { runTitle, type CitationSource, type EventLine } from './types'

const RUN_ENDED: Record<string, string> = { succeeded: '已完成', failed: '失败了', stopped: '已停止', cancelled: '已取消' }
const ISSUE_STATUS: Record<string, string> = { backlog: '待整理', todo: '待办', doing: '进行中', in_progress: '进行中', in_review: '评审中', done: '已完成', canceled: '已取消', cancelled: '已取消' }
const ACTION: Record<string, string> = { done: '操作已完成', failed: '操作失败', declined: '操作已拒绝' }
const WHAT: Partial<Record<EventLine['kind'], string>> = {
  runRetried: '换了一台机器继续', runSwitched: '订阅额度用完，改用 API Key 继续', runPaused: '订阅额度用完，已暂停',
  runWaitingDevice: '等设备上线后开始', runDeviceBack: '设备已上线，即将开始', runReport: '汇报了进展', runQuestion: '在等你回答', runBlocked: '受阻',
}

/**
 * An event line, as the web draws it (review C1): the thread or task by name, then what happened. The text the
 * model got (English, ids, instructions) is never shown. A server too old to send `line` gets a plain line.
 */
export function eventText(line: EventLine | undefined, sources: Record<string, CitationSource>): string {
  if (!line) return '有一条新动态'
  const run = line.runId ? sources[line.runId] : undefined
  const thread = run?.kind === 'run' ? runTitle(run) : '一个线程'
  const issue = line.issueId ? sources[line.issueId] : undefined
  const task = issue?.kind === 'issue' ? issue.title : line.title ? `「${line.title}」` : '一个任务'
  switch (line.kind) {
    case 'runFinished': return `${thread} ${(line.status && RUN_ENDED[line.status]) ?? '已结束'}`
    case 'issueStatus': return line.status && ISSUE_STATUS[line.status] ? `${task} 改为${ISSUE_STATUS[line.status]}` : `${task} 状态有变化`
    case 'artifact': return line.title ? `交来了「${line.title}」` : '交来了一份 Artifact'
    case 'action': return (line.status && ACTION[line.status]) ?? '操作有新状态'
    case 'other': return '有一条新动态'
    default: return `${thread} ${WHAT[line.kind] ?? ''}`.trim()
  }
}
