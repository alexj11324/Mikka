/** Why a model pick did not save, by the PUT /api/mobile/model error code (Figma 843:2 #3). */
export function choiceFailureReason(code: string | null): string {
  switch (code) {
    case 'modelUnavailable': return '这个模型现在不可用'
    case 'botNotFound': return '找不到这个 bot'
    case 'invalidModel': case 'originNotAllowed': return '需要更新 App'
    default: return '连不上 Mikka'
  }
}

/** 「没换成 claude-sonnet-5-5：这个模型现在不可用」 */
export const choiceFailureLine = (name: string, code: string | null) => `没换成 ${name}：${choiceFailureReason(code)}`
