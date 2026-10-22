import { Composio } from '@composio/core'

export function verifyComposioWebhook(request: Request, apiKey: string, secret: string) {
  return new Composio({ apiKey }).triggers.parse(request, { verifySecret: secret })
}
