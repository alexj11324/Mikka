# Agents never ask Alex for passwords; they inject test logins themselves

- Date: 2026-11-01
- Source: Alex: 「开发过程中不允许向我要密码，直接给我注入这个真实密码。」 and
  「你按道理你可以直接注入这个…登录信息才对的呀，凭什么你要被卡在这个地方？」
- Rule: —

## Rule

1. During development and testing, no session asks Alex for an account,
   password, session cookie or login step. If a test needs to be signed in, the
   session sets the login up itself.
2. **How:** generate a random password, hash it with `hashPassword` from
   `better-auth/crypto`, and insert a `credential` row into `account` for the
   user (create the `user` row first when the account is new). An existing
   account keeps its other sign-in methods (Google, GitHub); only a
   `credential` row is added, and only when it has none.
3. **Where the password goes:** Infisical project
   `89850d6a-f020-4936-863e-df77380dfe40`, the environment of the database
   (production → `prod`), as `<PURPOSE>_EMAIL` and `<PURPOSE>_PASSWORD` with a
   comment naming the user id. The password is never printed, logged,
   committed or put in a chat or PR; local copies live only in a 600-mode
   file in the session's scratchpad.
4. **Check it works** through the real sign-in route
   (`POST <base>/api/auth/sign-in/email`) before handing it to another
   session. Other sessions read it from Infisical; it is not relayed in
   messages.
5. Use a dedicated test account where one fits. When the test needs what only
   Alex's real account has (for example a linked GitHub identity), add the
   credential login to that account rather than asking him.
6. What still needs Alex is only what no code can do for him: a click on a
   third-party site under his identity (installing a GitHub App, an OAuth
   consent screen) or approving a permission prompt in a session. Ask for that
   one click, precisely, and nothing else.

## Accounts set up this way

| Purpose | Email | Infisical (prod, `/`) |
| --- | --- | --- |
| MVP end-to-end runs (GitHub-linked) | `zhixuanj@andrew.cmu.edu` | `MVP_TEST_EMAIL`, `MVP_TEST_PASSWORD` |
| YC demo recording (Acme, English) | `alex@acme.aspectlylabs.com` | `ACME_DEMO_EMAIL`, `ACME_DEMO_PASSWORD` |
