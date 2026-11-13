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
- Demo logins (password `demo1234`): 9090412 zimmedar, 9050001 zimmedar with the Tehsil/Town
  designation (District Khairpur), 9040001 district, 9030001 division, 9020001 suba, 9010001
  pakistan — all invented.

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
  - `--hr` (required): employees the HR import rejects never get villages — report sheet
    "Employee import nahi hua" (nobody is held since 13 Nov 2026; "Employee hold" stays empty). A `/2` or `/3` code in
    the Gaon file is the zimmedar of the code before "/" (CTO 10 Nov 2026). A District that differs
    from the named employee's own district goes to the pool of the file's District, unassigned
    ("District farq", CTO 13 Nov 2026).
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
two people are never merged into one account.

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

## No Tehsil level (CTO 13 Nov 2026)

The Tehsil level of 9 Nov 2026 is removed. A Tehsil/Town Zimmedar has the same job as an Ushar
Zimmedar and both report to the District.
- Hierarchy: Pakistan → Suba → Division → District → Ushar Zimmedar. Every zimmedar's `unitPath`
  is its District (`PK/<suba>/<division>/<district>`).
- HR import: `ٹاؤن /تحصیل ذمہ دار` (also "Tehsil", "Town", "Tehsil-Town") → role `zimmedar` with
  `zimmedari: tehsil_town` (shown as "Tehsil / Town" in the District's Zimmedaran list). Nobody is
  held for a missing Tehsil parent any more; a re-run moves existing accounts as well.
- No Tehsil dashboard: `DASHBOARD_ROLES` = `SUPERVISOR_ROLES` (District and above).
- One-time migration of a database made under the Tehsil level: `pnpm migrate:no-tehsil`
  (`src/modules/import/no-tehsil.ts`; dry-run by default, real run with
  `--operator "<who>" --confirm=ushr_live`). Tehsil accounts → zimmedar of their District,
  zimmedaran under a Tehsil → the District, Tehsil units → `isActive: false` (never deleted).
  Passwords, mobiles and Gaon assignments are untouched; audited as `MIGRATE_NO_TEHSIL`.
- **District pool with problems** (`village.issues`): a Gaon the import cannot assign waits in its
  District's pool with the reason — `ZIMMEDAR_NOT_FOUND`, `NOT_IMPORTED_EMPLOYEE`,
  `SUPERVISOR_CODE`, `DISTRICT_MISMATCH`, `SIMILAR_NAME` (a near-identical name in that District,
  with the suggested Gaon to merge into). `GET /dash/units/:code/villages` returns them on pool items.
  Fixes: assign (clears all), merge into the suggestion, rename (clears `SIMILAR_NAME`), or
  `POST /villages/:id/resolve-issue { kind }` (district and above, audited `VILLAGE_ISSUE_RESOLVE`).
- Official duty approver map (`DUTY_APPROVER` in `src/modules/jadwals/duty.ts`): Ushar →
  District, District → Division, Division → Suba; Suba / Pakistan: none in Demo v1.

## Import rules added 9 Nov 2026 (CTO)

- **No District fallback:** the Gaon file's District must map exactly (unit name or
  `data/district-names.csv`); an unknown, combined or empty District is an exception ("Gaon nahi
  mile") — never the employee's HR district.
- **Metropolitan Districts** are separate units (e.g. Sargodha vs Sargodha Metropolitan, Faisalabad
  vs Faisalabad Metropolitan); "Metropolitan" is never dropped when names are compared.
- `ڈویژن عشر ذمہ دار` → Ushar Zimmedar (`سرکاری ڈویژن ذمہ دار` stays Division).
- ~~Holds~~ (removed 13 Nov 2026): no Ushar Zimmedar is held for a missing Tehsil/Town parent.
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
zimmedar then sees the receipts by zimmedar and mad (no Gaon — Finance allows no Gaon field in the ERP,
CTO 12 Nov 2026). The zimmedar keeps typing only his
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
  (own totals, by mad, lines). Same periods and date range as the other reports.
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
| `Initial Receipt Date` | the date of the receipt in every report (Usher management, 12 Nov 2026); `Receipt Date` only when there is no Initial Receipt Date column |
| `User Login ID` | `ush` + Ajeer Code (any letter case); other IDs (e.g. `ush` + 11 digits) = row error |
| `Donation Mode` | `Cash` → naqad, `Material` → jins |
| `Amount In Base Currency` | rupees, rounded to the nearest rupee (some values carry float noise) |
| `Purpose Name` | mad (e.g. "Telethon Dawat-e-islami 2025") |
| `Fund Category` | kept (Wajiba / Nafila) |
| `Deposit / Undeposit` | kept (cash only) but ignored: every active receipt counts as wusooli, deposited or not (Usher management, 12 Nov 2026). `Final Batch` is ignored too |
| `Material Item`, `Weight / QTY`, `Unit` | jins item, quantity, unit |
| `Active / Cancel` | `CANCEL` lines never count |

`\N` (the export's empty value) is read as empty. There is **no Gaon** in the ERP and no
Gaon breakdown (a `gaon_name` column, if present, is ignored). When a later file has fewer lines for a receipt, the missing saved lines are
cancelled (never deleted).

## Meeting tasks and a day without Gaon (CTO 12 Nov 2026)

- `settings.donorTasks` — the ten meeting tasks from Usher management (multi-select), seed default in
  `src/modules/settings/donor-tasks.ts`: `count` = ask a number (toray / gattu: bags), `parts` = ask
  which part (sharai heela / jins muntaqili / farokht; janwar: niyyat / wusooli / farokht),
  A settings document without the list (the live one) uses the default — the live database is not
  changed for this. `GET /meta` → `donorTasks`.
- `settings.otherWork` — the day's other work, its own list (CTO 12 Nov 2026): ushr muntaqili, jins
  muntaqili, ushr farokht, jins farokht, sharai heela, janwar (parts: niyyat / wusooli / farokht).
  A day may be only Gaon, only other work, or both. `GET /meta` → `otherWork`.
- `PUT …/visits/:visitId/donors` takes `tasks` on each new donor and `oldTasks` for the old donors
  met (one list until the donor list is imported). Checked by `checkTasks` (`jadwals/tasks.ts`):
  `UNKNOWN_TASK`, `TASK_COUNT_REQUIRED`, `TASK_COUNT_NOT_ALLOWED`, `TASK_PARTS_REQUIRED`,
  `TASK_PART_UNKNOWN`; stored in settings order.
- `POST /jadwals/:id/submit` takes `otherTasks` (from `otherWork`, else `UNKNOWN_TASK`). An amli
  day may now have no Gaon when it has other work; with neither → `NO_VISITS` as before.
- Not in reports yet (totals unchanged) — counts per task can be added when the reports are defined.

## Donors of a Gaon (CTO 12 Nov 2026)

- **Import:** `pnpm import:donors "private/<donor list>.csv" --dry-run`, then
  `--operator "<who>" --confirm=ushr_live`. Run after the employee and Gaon imports. Columns: Mulk,
  Soba, Division, District, Tehsil, ID, User Name, گاؤں کا نام, گاؤں ذمہ دار کا نام / نمبر, نام ڈونر,
  ڈونر موبائل نمبر, زیر کاشت رقبہ(ایکڑ). District from the District column (or, when it does not map,
  the ID's District); the Gaon by name inside that District (former names too; a loose spelling match
  only when it is the only one). Gaon not found → report (`private/donor-import-report-*.xlsx`), imported
  later by running the same file again. One donor per mobile per Gaon (without a mobile: per name);
  nothing is doubled. The Gaon's local zimmedar (name, mobile) is saved on the Gaon. Audited
  (`IMPORT_DONORS`). Terminal output: counts only.
- **A donor belongs to its Gaon:** whoever has the Gaon assigned sees its donors.
  `GET /villages/:id/donors?date=` (zimmedar of that Gaon) → the Gaon's local zimmedar and its old
  donors: every imported donor, and a donor a zimmedar added on an earlier day; `isNew` = added by a
  zimmedar and not met since; `lastMet` = date and tasks of the latest meeting.
- **Meeting:** `PUT …/donors` takes `met: [{ donorId, tasks? }]` (old donors of that Gaon only, else
  `DONOR_NOT_IN_VILLAGE` / `DONOR_TWICE`); `oldMet` becomes their number. On submit each met donor
  gets this meeting (a back-dated day never replaces a later last meeting) and each new donor of the
  day joins its Gaon's list from the next day (`source.kind: zimmedar`).
- Collection `donors` (unique Gaon + mobile; Gaon + name key; unitPath). The demo seed adds invented
  donors and a local zimmedar to 9090412's first two Gaon.

## Wusooli without a mad (CTO 13 Nov 2026, option A)

- A wusooli entry may have no `category`: the zimmedar writes the Gaon's **naqd total**
  (`kind: naqd`, amount ≥ 1) and **jins items** (`kind: jins`, `detail` = what, `qty` + `unit` = how
  much, `amount` = value, 0 allowed). The ERP brings the mad. Niyyat entries still need their mad.
- Reward until the reward work: a wusooli entry without a mad counts in `rewardWusooli` when naqd,
  never when jins; GSB as before. Entries with a mad (saved before) keep the category rule, and
  submitted jadwals keep their stored totals.

## Task counts in reports (CTO 13 Nov 2026)

`GET /me/tasks?period=…` (own) and `GET /dash/units/:code/tasks?period=…` (unit, scope) → for every
meeting task how often it was ticked (`times`; per donor, the old-donor list without names once) and,
for a count task, the numbers added up (`units`, e.g. toray / gattu bags); for every other work the
days it was done. Counted from submitted amli jadwals (earlier days too). The zimmedar's Excel gets a
"کام" sheet; the dashboard zimmedaran / children Excel a "Kaam" sheet.

## ERP: donors, written vs ERP, a zimmedar's detail (CTO 13 Nov 2026)

- The donor's **name** is read (`donor_name` / E-Raseed "Donor Name"; never a mobile) and kept on each
  receipt line. The browser still drops every other personal column before upload.
- Every ERP report puts **what was written in UsherDesk** (submitted jadwals' wusooli, same period)
  next to what the ERP shows reached the account: `totals.written`, and `written` on each zimmedar /
  child-unit row of `GET /dash/units/:code/erp`.
- `GET /dash/zimmedaran/:userId/erp?period=…` (a zimmedar in the caller's scope, else 404) and
  `GET /me/erp`: totals with `written`, by mad, **by donor**, and the lines (with the donor's name).
- `lastUpload` has `dateFrom` and `dateTo` (the dashboard can jump to the last upload's dates).

## Niyyat per donor (CTO 13 Nov 2026)

- A niyyat entry without a mad has its donor (`donorId` of an old donor of the Gaon, or
  `newDonorName` of a new donor already saved on the visit — else `NEW_DONOR_UNKNOWN`),
  `niyyatType` (`ushr` / `atiya`), `dueMonth` (YYYY-MM), and naqd (amount) or jins (`detail`,
  `qty`, `unit`, optional value). Niyyat with a mad saved earlier keep working.
- On submit each becomes a **pledge** (`pledges`, one per entry; a re-submit updates it, a niyyat
  removed from a reopened day is marked `cancelled`, never deleted).
- `GET /villages/:id/donors` shows each donor's `openPledges`. The donors step takes
  `met[].closePledges` (open niyyat of that donor only, else `PLEDGE_NOT_OPEN`); on submit they
  become `received` with the date.
- Reports: `GET /me/pledges` and `GET /dash/units/:code/pledges` → open now (total, عشر, عطیہ, by
  month), written and received in the period (naqd and jins by item / unit).
- Demo seed: 9000004 keeps the back-date window free of history and has invented donors in every
  Gaon (for the end-to-end tests).

## Test-mode Ushar Zimmedar (CTO 13 Nov 2026)

- `pnpm provision:test-user --dry-run`, then `--operator "<who>" --confirm=ushr_live`: creates the
  sandbox units **TEST → TEST_SUBA → TEST_DIV → TEST_DIST** (outside PK), the account **999999001**
  (`isTest`, initial password `demo1234`, must be changed at first login), three test Gaon with nine
  invented donors and a local zimmedar. Idempotent; touches nothing outside TEST; audited.
- Every report, dashboard, ERP view and import is scoped under PK, so nothing the test account does
  is counted anywhere. The national unit is always looked up by its code `PK` (HR import root, Pakistan
  Admin provisioning), never by level alone.
- His test data before today is cleared at each login; `POST /me/test-reset` (the test account only,
  else 403) clears all of it — jadwals, niyyat, donors he added, meetings on the test donors, Gaon he
  added. Audit entries are kept.
- `pnpm seed --test-user` adds him to a demo database (end-to-end tests; no forced password change).
