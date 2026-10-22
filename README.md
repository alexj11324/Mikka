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

Copy `.env.example` to `.env.local` and add the local database, Better Auth, and provider credentials. The app is served at `/mikka`, so register both Google OAuth redirect URIs in Google Cloud:

```text
http://localhost:3000/mikka/api/auth/callback/google
https://app.aspectlylabs.com/mikka/api/auth/callback/google
```

Google login requests only the standard sign-in identity and email scopes. Set `BETTER_AUTH_URL` to the origin (`http://localhost:3000` locally and `https://app.aspectlylabs.com` in Production); Better Auth adds `/mikka/api/auth`. Keep the Production value on the custom domain so its Google callback matches the registered URI. Existing email/password users can sign in with their password and link Google under Settings → Integrations; Mikka keeps Better Auth's verified-email account-linking check enabled.

Notion and Slack connections use Composio-managed OAuth and the signed-in Mikka user ID. Set `COMPOSIO_API_KEY` on the server and configure Composio's callback verifier to `https://app.aspectlylabs.com/mikka/api/integrations/composio/callback`. Set the same URL in `COMPOSIO_CALLBACK_VERIFIER_URL`; Mikka only starts connection flows when the values match. Composio keeps the connection pending until the signed-in Mikka user completes it. Local connection testing requires an HTTPS tunnel and a Composio project configured for that tunnel.

Composio event deliveries use `POST /mikka/api/webhooks/composio`. Set `COMPOSIO_API_KEY` and `COMPOSIO_WEBHOOK_SECRET` on the server and register `https://app.aspectlylabs.com/mikka/api/webhooks/composio` in Composio. The receiver verifies and acknowledges events; app-specific event actions still need to be selected. Local webhook testing needs a public HTTPS tunnel.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Learn More

To learn more, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [v0 Documentation](https://v0.app/docs) - learn about v0 and how to use it.
