import Link from 'next/link'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export function AcceptanceEntry() {
  return <main className="flex min-h-svh items-center justify-center bg-background p-6">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle><h1>继续验收</h1></CardTitle>
        <CardDescription>未能建立或保留验收会话。无需填写邮箱、密码或进行 GitHub 授权。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <a href="/api/acceptance" className="text-sm underline underline-offset-4">重新进入验收工作台</a>
        <a href="/api/acceptance" target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">在新标签页打开验收</a>
        <p className="text-sm text-muted-foreground">如果预览限制了第三方 Cookie，请使用新标签页入口。</p>
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-2">
        <p className="text-xs text-muted-foreground">仅限开发预览。任务与项目真实保存，且与正式账号数据隔离。</p>
        <Link href="/sign-in?login=1" className="text-xs text-muted-foreground underline underline-offset-4">改用自己的账号登录</Link>
      </CardFooter>
    </Card>
  </main>
}
