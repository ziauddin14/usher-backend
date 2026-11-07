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

|                 |                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| Build           | `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build`                                   |
| Start           | `pnpm start` → `node dist/server.js`                                                                             |
| Health check    | `GET /api/v1/health` (200 when the database answers, 503 when not)                                               |
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

## Real-data imports (HR employees, official Gaon list)

Order: **employees first, then villages** (villages are matched to zimmedaran by Ajeer Code).
Both always use the live database (`LIVE_MONGODB_URI`, or `MONGODB_URI`'s server with `ushr_live`).

```bash
pnpm import:employees private/<hr-file>.xlsx --dry-run
pnpm import:employees private/<hr-file>.xlsx --operator "<who>" --confirm=ushr_live
pnpm import:villages  private/<gaon-file>.xlsx --dry-run
pnpm import:villages  private/<gaon-file>.xlsx --operator "<who>" --confirm=ushr_live
```

- A dry run writes nothing; every run writes an Excel report to `private/` (rejected rows,
  warnings, same-code rows, mobile differences, access changes / unmatched districts, district pool,
  kept assignments, earlier-spelling matches).
- A real run must name the operator and confirm the database by name; it writes one
  `IMPORT_EMPLOYEES` / `IMPORT_VILLAGES` audit entry (counts and file name only).
- **Employees** — matched by Ajeer Code (`12345/1` → login `12345`). New accounts: password
  `demo1234` + forced change (login = Ajeer Code + password only). A repeated import never changes a
  password, `mustChangePassword`, `isActive`, a mobile on record or a Pakistan Admin account;
  role / zimmedari / unit changes are applied
  (HR is the source) and listed on the report sheet "Tabdeeliyan".
- **Villages** — matched per district by normalized name, an earlier spelling or a merged duplicate;
  otherwise created (`source: import`, file, row). A village already given to a zimmedar keeps its
  assignment; merged villages never come back.

Columns read (header text; case, spaces and punctuation ignored): see `COLUMNS` in
`src/modules/import/employees.ts` and `src/modules/import/villages.ts`.

## District Gaon management and own mobile (API)

| Endpoint                                                     | Who                          | What                                                                                       |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /villages/manage` `{ name, districtCode?, assignTo? }` | district and above, in scope | Add an approved village (409 `VILLAGE_EXISTS` with the existing one — assign that instead) |
| `PATCH /villages/:id` `{ name?, tehsil? }`                   | district and above           | Correct spelling / tehsil; the old name stays in `formerNames`                             |
| `GET /villages/duplicates?unit=`                             | district and above           | Look-alike names in a district (suggestion only)                                           |
| `POST /villages/:id/assign` · `/merge` · `/approve`          | district and above           | Assign / reassign, merge, approve                                                          |
| `GET /auth/mobile` · `PUT /auth/mobile` `{ mobile }`         | any user (password changed)  | Own optional mobile, masked; set / change / remove (`''` or `null`) at once                |

All of them are audited (`VILLAGE_CREATE`, `VILLAGE_RENAME`, `VILLAGE_REASSIGN`, `VILLAGE_MERGE`,
`MOBILE_UPDATE` with masked numbers).

**No mobile verification (CTO 7 Nov 2026):** login is Ajeer Code + password only; the mobile is an
optional profile field the user changes without approval. A forgot-password request matches it; a
user without one asks a supervisor, who can reset any user below them.

**Gaon visibility (CTO 7 Nov 2026):** a zimmedar sees, searches and uses in a jadwal only the villages
assigned to them. Pool villages and other zimmedaran's villages are never offered; the District
assigns them. A zimmedar may still propose a brand-new name (pending, District approves); a name
that already exists answers 409 `VILLAGE_EXISTS` with `mine: false` unless it is already theirs.

**First look at an official file** (no database, prints no names / codes / mobiles):

```bash
pnpm inspect:file private/<hr-file>.xlsx --kind employees
pnpm inspect:file private/<gaon-file>.xlsx --kind villages
```

Ajeer Codes written `/2`, `/3` … are **held**: never imported, listed on the report sheet
"Code 2, 3 - rukay hue" until the CTO decides their mapping.
