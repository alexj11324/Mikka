/**
 * What a thread page says when a message to it is refused, by the server's
 * error code, in the web's words (messages/zh-CN.json Errors). Without a code
 * the app could not reach the server, and sending again is one tap.
 */
const LINES: Record<string, string> = {
  threadReplaced: '这个任务已经换到新的线程，请在那里发送。',
  threadCannotContinue: '这个线程没有关联任务，无法再次运行。',
  threadStopping: '线程正在停止',
  agentRepoMissing: '这台设备上没有该仓库。',
  agentNoDevice: '所选 Agent 还没有可用电脑。',
  runNotFound: '运行不存在。',
}

export function threadSendErrorLine(code: string | null): string {
  return (code && LINES[code]) || '没发出去，再试一次。'
}
