# ushr-backend — UsherDesk API

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
- Demo logins (password `demo1234`): 9090412 zimmedar, 9050001 tehsil (Khairpur Town),
  9040001 district, 9030001 division, 9020001 suba, 9010001 pakistan — all invented. The seed has
  one demo Tehsil, `KHAIRPUR_TOWN` under District Khairpur, holding Khairpur's Ushar Zimmedaran.

## Real-data imports (HR employees, official Gaon list)

Order: **employees first, then villages** (villages are matched to zimmedaran by Ajeer Code).
Both always use the live database (`LIVE_MONGODB_URI`, or `MONGODB_URI`'s server with `ushr_live`).

```bash
pnpm import:employees private/<hr-file>.xlsx --dry-run
pnpm import:employees private/<hr-file>.xlsx --operator "<who>" --confirm=ushr_live
pnpm import:villages  private/<gaon-file>.xlsx --hr private/<hr-file>.xlsx --dry-run
pnpm import:villages  private/<gaon-file>.xlsx --hr private/<hr-file>.xlsx --operator "<who>" --confirm=ushr_live
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
  otherwise created (`source: import`, file, row); one village per district + name. A village already
  given to a zimmedar keeps its assignment; merged villages never come back.
  - `Employee Code` is the Ajeer Code, matched **exactly**; `Usher Zimmedar Name` is a reference in
    the report only, never matched. Only a user whose role is `zimmedar` gets an assignment; a
    supervisor's villages go to the district pool. The village contact columns are never read.
  - `--hr` (required): employees the HR import rejects or holds (no Tehsil parent) never get
    villages — report sheets "Employee import nahi hua" and "Employee hold". A `/2` or `/3` code in
    the Gaon file is the zimmedar of the code before "/" (CTO 10 Nov 2026). A District that differs
    from the named employee's own district is not imported ("District farq").
- **Designations** that map to no role are rejected and tabled on "Designation - tasdeeq" (designation,
  rows, a blank role column for the department) and "Designation rows"; no role is assigned
  automatically.

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

Ajeer Codes written `/2`, `/3` … (CTO 10 Nov 2026) are imported like any other row: the zimmedar
logs in with the code **before "/"** (`12345/2` → `12345`); the full code stays in `ajeerCodeFull`,
and the rows are listed on "Code 2, 3 - login pehla code". Several rows of one login code (e.g.
`/1` and `/2`) with the **same name** are one person: one account from the first valid row, all rows
listed on "Aik code - 1 aur 2". A different name on the same code is an error (first row kept), so
two people are never merged into one account. The Tehsil-parent hold still applies to them.

## Initial passwords (CTO 7 Nov 2026)

- A **newly created** account gets the initial password `demo1234`, stored only as a bcrypt hash
  (cost 10), with `mustChangePassword: true`. New accounts come from the HR import (set only with
  `$setOnInsert`) or, for a Pakistan Admin, from central provisioning; a supervisor reset sets it again.
- Until the password is changed, every protected API answers `403 PASSWORD_CHANGE_REQUIRED`; only
  `/auth/me`, `/auth/change-password` and `/auth/logout` stay open. The new password may not be
  `demo1234` or the Ajeer Code and needs at least 6 characters. Then normal role-based access applies.
- A repeated HR import never sets, resets or re-hashes the password of an existing account.
- Covered for every role (zimmedar, district, division, suba, pakistan) by
  `src/modules/auth/first-login-roles.test.ts`.

## Tehsil level (Phase 2, CTO 9 Nov 2026)

- Hierarchy: Pakistan → Suba → Division → District → **Tehsil** → Ushar Zimmedar. Unit paths are
  fixed depth: `PK/<suba>/<division>/<district>/<tehsil>`. An Ushar Zimmedar's `unitPath` is its
  Tehsil; every higher level keeps prefix scope, so a District still sees all its Ushar.
- HR import: `ٹاؤن /تحصیل ذمہ دار` (also "Tehsil", "Town", "Tehsil-Town") → role `tehsil`. Its
  Tehsil unit comes from the exact District + Town of that row (the Town name is compared exactly,
  level words are kept). Ushar rows point to that Tehsil; without one they stay held. Held rows
  and officials' records create District units only, never a Tehsil. Password rules unchanged.
- **Tehsil Zimmedar** (`tehsil`): read-only dashboards of its own Tehsil only (`DASHBOARD_ROLES`).
  No password reset, no activate / deactivate, no reset requests, no Gaon management, no reopen,
  no official-duty decision (`SUPERVISOR_ROLES` stays District and above; the services check too).
- **Gaon** stay owned by the District (`village.unitPath` = District path). Every Gaon check uses
  `districtPathOf()` / `districtCodeOf()` (`src/lib/scope.ts`), never path equality. A Tehsil
  sees the villages assigned to its own Ushar, never the District pool.
- **Official duty** approver map (`DUTY_APPROVER` in `src/modules/jadwals/duty.ts`): Ushar →
  District, District → Division, Division → Suba. Tehsil: no approved duty workflow (403);
  Suba / Pakistan: none in Demo v1.
- Gaon import (CTO 9 Nov 2026): a Tehsil Zimmedar's code in the Gaon file → the District pool of
  the file's District (never assigned to the Tehsil or to any Ushar automatically; the District
  assigns it to an active Ushar Zimmedar through the normal workflow). District farq and the other
  exception rules apply to Tehsil codes as before.

## Import rules added 9 Nov 2026 (CTO)

- **No District fallback:** the Gaon file's District must map exactly (unit name or
  `data/district-names.csv`); an unknown, combined or empty District is an exception ("Gaon nahi
  mile") — never the employee's HR district.
- **Metropolitan Districts** are separate units (e.g. Sargodha vs Sargodha Metropolitan, Faisalabad
  vs Faisalabad Metropolitan); "Metropolitan" is never dropped when names are compared.
- `ڈویژن عشر ذمہ دار` → Ushar Zimmedar (`سرکاری ڈویژن ذمہ دار` stays Division).
- **Holds** (HR `ٹاؤن` column): an Ushar Zimmedar is imported only when the HR file has a
  Tehsil/Town Zimmedar for exactly the same District + Town, else held ("Tehsil parent nahi").
  Held employees get no account and no village ("Employee hold" in the Gaon report); their HR
  District still applies "District farq".
- **HR units** (Suba / Division / District) are created from importable and held rows — once each,
  the same in dry run and real run; no unit is created from a name that is not in the HR file.
- **District units from officials' records** (CTO 9 Nov 2026): a District written on an authorized
  Division / Suba official's verified HR row becomes a District unit even without a District-level
  employee — no account is created and its responsible person stays blank. Only confirmed names
  (an existing unit or a `district-names.csv` entry); other names are listed on "District - tasdeeq
  baqi" and no unit is created.

## Date range for reports (CTO 11 Nov 2026)

- `period=range&from=YYYY-MM-DD&date=YYYY-MM-DD` (`date` = the last day, today when missing) on
  `GET /me/summary`, `GET /me/export.xlsx`, `GET /dash/units/:code/{overview,zimmedaran,children}`
  and `GET /dash/export.xlsx`. The same scope rules as every other period.
- Checked once (`src/lib/date-range.ts`): `from` is required, on or before the last day, never after
  today, at most 366 days. Otherwise 400 `VALIDATION_FAILED`.
- A single day stays `period=day&date=…`. Excel names a range `…-range-<from>_<to>.xlsx`.

## Keep-alive behind the proxy

Both servers (`src/server.ts`, `scripts/dev.ts`) keep idle connections for 65 s
(`src/lib/keep-alive.ts`), longer than the proxy in front of the API, so a reused socket is never
one the server has just closed (Node's 5 s default showed up as ECONNRESET / "socket hang up").

## Bus fare at the end of the day (CTO 11 Nov 2026)

`POST /jadwals` with `travel: { mode: 'bus' }` no longer needs a fare. `POST /jadwals/:id/submit`
takes `fare` (integer rupees, 0 allowed) and needs one on a bus day (400 `FARE_REQUIRED`). A fare
sent at the start by an older app, or kept from before a reopen, is used when none is sent.

## ERP (E-Raseed) receipts upload (CTO 11 Nov 2026)

The Pakistan level uploads the ERP's daily receipts file; every dashboard (own scope) and every
zimmedar then sees the receipts by zimmedar, Gaon and mad. The zimmedar keeps typing only his
day's total in the jadwal; the ERP brings the details. The reward is **not** changed by this.

- `POST /erp/uploads?name=<file>&commit=false|true` (role `pakistan`), body = the file bytes (CSV
  UTF-8 or .xlsx, max 5 MB / 20,000 rows). `commit=false` only checks (nothing saved);
  `commit=true` saves the valid rows (201) and writes an `ERP_UPLOAD` audit log. Rows with an
  error are never saved; the answer lists them by row number and reason (no personal data).
- A line is `(receipt_no, line_no)`: the same file twice adds nothing; a changed line (e.g. now
  `CANCELLED`) is updated. Nothing is deleted. Cancelled lines never count.
- `GET /erp/uploads` (last 20 uploads, counts only), `GET /erp/template.csv` (the format with
  invented sample rows, for the ERP / Finance team).
- Reports: `GET /dash/units/:code/erp?period=…` (totals, by mad, one row per child unit or, for a
  District / Tehsil, per zimmedar — 0 when the ERP has nothing for him) and `GET /me/erp?period=…`
  (own totals, by Gaon, by mad, lines). Same periods and date range as the other reports.
- Collections `erpReceipts` (unique `receiptNo + lineNo`; indexes `unitPath + date`,
  `userId + date`) and `erpUploads`. A line is filed under the zimmedar's unit when first saved.

File format (header row required; titles above it are skipped; header names are matched without
case, spaces or `_`):

| Column | Required | Notes |
|---|---|---|
| `receipt_no` | yes | ERP receipt number |
| `line_no` | no (1) | when one receipt has several lines (mad / material) |
| `receipt_date` | yes | `YYYY-MM-DD` or day-first `DD/MM/YYYY`; not after today |
| `ajeer_code` | yes | the zimmedar; `12345/2` counts as `12345` (login code). Unknown code = row error |
| `gaon_name` | no | linked to a Gaon of the zimmedar's District when the name matches one Gaon |
| `attiyat_type` | yes | `NAQAD` (cash) or `JINS` (material) |
| `amount_rs` | yes | whole rupees (`5,000` and `5000.00` accepted); NAQAD > 0; JINS = its value |
| `mad` | no | as the ERP names it (not mapped to the app's atiyat categories) |
| `jins_item`, `jins_qty`, `jins_unit` | item required for JINS | e.g. `Chawal`, `40`, `KG` |
| `status` | no (ACTIVE) | `ACTIVE` or `CANCELLED` |
| `suba`, `division`, `district`, `tehsil` | no | ignored — the unit comes from the Ajeer Code |

### The E-Raseed "General" export as it is downloaded (sample of 11 Nov 2026)

The ERP gives two CSV files, **Cash** and **Material**, with 91 columns each; they are uploaded one
after the other, unchanged. The browser keeps only the columns below before upload (donor names,
mobiles and the other ~78 columns never leave the computer; a month of cash went from 9.5 MB to
1.2 MB). Mapping:

| E-Raseed column | Read as |
|---|---|
| `Receipt Number` | receipt; its rows are lines 1, 2, … in file order (no line column in the export) |
| `Receipt Date` | the date of the receipt (`Initial Receipt Date` is not used — open question) |
| `User Login ID` | `ush` + Ajeer Code (any letter case); other IDs (e.g. `ush` + 11 digits) = row error |
| `Donation Mode` | `Cash` → naqad, `Material` → jins |
| `Amount In Base Currency` | rupees, rounded to the nearest rupee (some values carry float noise) |
| `Purpose Name` | mad (e.g. "Telethon Dawat-e-islami 2025") |
| `Fund Category` | kept (Wajiba / Nafila) |
| `Deposit / Undeposit` | kept (cash only); every active receipt counts for now — open question |
| `Material Item`, `Weight / QTY`, `Unit` | jins item, quantity, unit |
| `Active / Cancel` | `CANCEL` lines never count |

`\N` (the export's empty value) is read as empty. The export has **no Gaon column**: those lines
have no Gaon. When a later file has fewer lines for a receipt, the missing saved lines are
cancelled (never deleted).

## Meeting tasks and a day without Gaon (CTO 12 Nov 2026)

- `settings.donorTasks` — the ten meeting tasks from Usher management (multi-select), seed default in
  `src/modules/settings/donor-tasks.ts`: `count` = ask a number (toray / gattu: bags), `parts` = ask
  which part (sharai heela / jins muntaqili / farokht; janwar: niyyat / wusooli / farokht),
  `dayTask` = also offered as the day's other work. A settings document without the list (the live
  one) uses the default — the live database is not changed for this. `GET /meta` → `donorTasks`.
- `PUT …/visits/:visitId/donors` takes `tasks` on each new donor and `oldTasks` for the old donors
  met (one list until the donor list is imported). Checked by `checkTasks` (`jadwals/tasks.ts`):
  `UNKNOWN_TASK`, `TASK_COUNT_REQUIRED`, `TASK_COUNT_NOT_ALLOWED`, `TASK_PARTS_REQUIRED`,
  `TASK_PART_UNKNOWN`; stored in settings order.
- `POST /jadwals/:id/submit` takes `otherTasks` (dayTask tasks only, else `NOT_A_DAY_TASK`). An amli
  day may now have no Gaon when it has other work; with neither → `NO_VISITS` as before.
- Not in reports yet (totals unchanged) — counts per task can be added when the reports are defined.
