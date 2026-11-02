/**
 * The sign-in screen's line for a failed sign-in, by better-auth's error code
 * (copy.md C-08: say what went wrong). Rate limits come as HTTP 429.
 */
export function signInErrorLine(error: { code?: string; status?: number } | null | undefined): string {
  if (error?.status === 429) return '尝试太频繁，请稍后再试。'
  switch (error?.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'USER_EMAIL_NOT_FOUND': return '邮箱或密码不对。'
    case 'INVALID_EMAIL': return '邮箱格式无效。'
    case 'EMAIL_NOT_VERIFIED': return '邮箱还没验证，请先在邮件里点验证链接。'
    case 'PROVIDER_NOT_FOUND': return '暂时不能用这个方式登录，请换一种。'
    default: return '登录没成功，请稍后重试。'
  }
}
