# Mikka

This is a [Next.js](https://nextjs.org) project bootstrapped with [v0](https://v0.app).

## Built with v0

This repository is linked to a [v0](https://v0.app) project. You can continue developing by visiting the link below -- start new chats to make changes, and v0 will push commits directly to this repo. Every merge to `main` will automatically deploy.

[Continue working on v0 →](https://v0.app/chat/projects/prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH)

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Google login and Composio

The app is served at `/mikka`. Use separate Google Cloud projects and OAuth clients for development and production. Register only the local callback on the development client and only the production callback on the production client:

```text
http://localhost:3000/mikka/api/auth/callback/google
https://app.aspectlylabs.com/mikka/api/auth/callback/google
```

Google login requests only `openid`, `email`, and `profile`. Set `BETTER_AUTH_URL` to the origin (`http://localhost:3000` locally and `https://app.aspectlylabs.com` in Production); Better Auth adds `/mikka/api/auth`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` separately for each environment. Keep provider credentials in a secret manager or inject them into the local process; do not persist them in `.env.local`. Google branding verification requires a public Mikka homepage with a service description and links to privacy and terms pages on a verified domain; those pages are not in this repository yet. Existing email/password users can sign in with their password and link Google under Settings → Integrations; Mikka keeps Better Auth's verified-email account-linking check enabled.

Notion and Slack connections use Composio-managed OAuth and the signed-in Mikka user ID. Set `COMPOSIO_API_KEY` on the server and configure Composio's callback verifier to `https://app.aspectlylabs.com/mikka/api/integrations/composio/callback`. Set the same URL in `COMPOSIO_CALLBACK_VERIFIER_URL`; Mikka only starts connection flows when the values match. Composio keeps the connection pending until the signed-in Mikka user completes it. Local connection testing requires an HTTPS tunnel and a Composio project configured for that tunnel.

Composio outbound event delivery uses a webhook subscription. Configure the subscription URL as `https://app.aspectlylabs.com/mikka/api/webhooks/composio`, select the event types the app should receive, and save the subscription signing secret as `COMPOSIO_WEBHOOK_SECRET` on the server. The receiver verifies and acknowledges events; app-specific event actions still need to be selected. Local webhook testing needs a public HTTPS tunnel and a subscription pointed at that tunnel.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Learn More

To learn more, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [v0 Documentation](https://v0.app/docs) - learn about v0 and how to use it.
