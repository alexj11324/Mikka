# Development workflow

Set up a cloud Linux session with `eval "$(scripts/dev/bootstrap-local.sh)"` ([local-bootstrap.md](local-bootstrap.md)).

Signup limits never block local work: outside production and Vercel, with `MIKKA_LOCAL_TEST_ACCOUNTS=1` and a loopback `*_e2e` app database, the signup and verification limits default to CI's (1000 per IP, 10000 overall, each hour) instead of 5 per IP; an explicitly set `MIKKA_SIGNUP_*_HOURLY` or `MIKKA_VERIFICATION_*_HOURLY` still wins (`lib/abuse/signup.ts`). `next start` runs with `NODE_ENV=production`, so a production build keeps the production defaults unless those variables are set, as the bootstrap's export line does.
