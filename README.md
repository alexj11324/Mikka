# #2254 sidebar receipt on the original conversation prerequisite

Public #2268 ed7d01878d49563c99bc0ced1484b91d9f8be6ba paired with the scoped, immutable original #131 + #132 private verification revision d4e39617442955c36b6698897d548a74203f015b. The private combination adds only the public-facing count behavior and its existing mounted fixture to original private #131. Its normal private merge SHA is tracked separately at #132.

On 2026-11-14 UTC, the public production Web builder exited 0 at 20:59:48, renderer e8ebf8b740208210aa381dc5cbe01ca5d8e4675734cfcc0347f71cc107e67443. Both complete TypeScript projects and all 251 private tests passed.

Chromium 153.0.8010.0 used this production Web bundle and the real application API fetch entry through a disposable same-origin source adapter. Two users signed into the isolated PostgreSQL 17 fixture. Between 21:15:20 and 21:16:03 UTC, the member write returned 404. For each light/dark desktop and phone-sized Web viewport the owner marked two rows unread, opened one, received 200, reloaded, and verified the database and the displayed counts (bot 2 to 1, children [1,1] to [0,1]). The receipt records a SHA-256 digest for each screenshot.

The production Nitro build completed 325 routes, 431 methods and 132 steps (7 workflows). Its final Rolldown process exited 137 at 21:03:33 UTC. No formal Nitro acceptance, native device, model run, deployment or customer data is included in these receipts.
