# The store lists every Composio app, including own-key and no-connection ones

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator: Exa, Firecrawl, Cloudflare and others are in Composio but missing from Mikka's store. Import all of Composio's apps, and make the ones that need the person's own token work too.
- Rule: R-35 (connections per person), R-40 (data, not filler)
- Replaces: the 现状 note in `personal-plugins-backend.md` that left own-credential and no-auth toolkits out (decision 2026-10-31)

The 插件 store lists every Composio toolkit except local ones and Composio's
copies of GitHub, Linear and Telegram. Each card shows how the app connects,
from Composio's auth schemes:

- 一键授权: Composio-managed OAuth; `+` opens Composio's hosted flow as before.
- 需要 API Key: the person's own API key, bearer token or login. `+` opens a
  dialog whose fields are Composio's for that scheme (a choice of scheme when
  Composio offers several), with 「去哪里拿 Key」 linking to Composio's
  guide, or to the app's site when Composio has no guide. Secret fields are
  masked and never autofilled. Once connected, `…` and the app's page offer
  更换 Key (a new account replacing the old one), and the usual rename,
  default, turn off and disconnect.
- 无需连接: no control; Bots can call its tools at once.
- An app that only offers OAuth without Composio-managed auth has no tag and
  no control: connecting it would need a developer app of the person's own.

Credentials go only from the server to Composio, which keeps them with the
person's connected account; Mikka stores, logs and returns none of them. The
account belongs to the signed-in person like an OAuth connection, and the
workspace app policy and Bot run injection apply unchanged.
