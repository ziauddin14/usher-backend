# ushr-backend — USHR Amli Jadwal API

Express 5 + TypeScript + Mongoose (MongoDB). Serves `/api/v1/*` for the web app
[`ushr-frontend`](../ushr-frontend). The browser never calls this API directly: the frontend's
`/api/:path*` rewrite forwards to it, so the session cookie stays first-party.

Specifications (scope, data model, API, design, deployment) live in the project's specs repository
(the original `Usher` repo, `docs/demo-v1/`). Split from it on 7 Nov 2026 with full history of
`backend/`.

## Requirements

- Node.js 24 · pnpm 10 (`corepack enable`)
- MongoDB 8 — locally via Docker (`docker compose up -d`) or MongoDB Atlas

## Run locally

```bash
pnpm install
cp .env.example .env        # fill MONGODB_URI, JWT_SECRET
docker compose up -d        # local MongoDB 8 on :27017
pnpm seed                   # invented demo data into ushr_demo (idempotent)
pnpm dev                    # http://localhost:4000/api/v1/health
```

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Tests use `mongodb-memory-server` (no running database needed).

## Production (Render)

`render.yaml` is the blueprint (no secrets in it):

| | |
|---|---|
| Build | `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build` |
| Start | `pnpm start` → `node dist/server.js` |
| Health check | `GET /api/v1/health` (200 when the database answers, 503 when not) |
| Env (dashboard) | `MONGODB_URI`, `JWT_SECRET`, `ALLOWED_ORIGIN` (https Vercel origin), `NODE_ENV=production`, `TRUST_PROXY_HOPS=2` |

With `NODE_ENV=production` the session cookie is `Secure` and the API refuses to start with a local
database or a non-https `ALLOWED_ORIGIN`. Atlas must allow Render's outbound addresses (the free plan
has no static IP).

## Data and safety

- `ushr_demo` holds only invented seed data; `ushr_live` only the real imports. The seed refuses a
  live database; imports write only to `LIVE_MONGODB_URI`; admin CLIs need `--db` and `--confirm`.
- Real files go in `private/` (git-ignored) and are never committed. Never commit `.env`.
- Demo logins (password `demo1234`): 9090412 zimmedar, 9040001 district, 9030001 division,
  9020001 suba, 9010001 pakistan — all invented.
