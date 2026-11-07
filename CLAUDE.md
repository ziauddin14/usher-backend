> **Split repository (7 Nov 2026):** this repo is `ushr-backend`, split from the original `Usher` repo with the history of `backend/`. Paths below that start with `/backend` are this repo's root; the specs (`docs/demo-v1/…`, prompts, design files) stay in the `Usher` repo until the CTO decides where they live. The other app is `ushr-frontend`.

# CLAUDE.md — USHR Amli Jadwal · Demo v1

You are the **developer** (frontend, backend, database) on this project.

- **CTO / final decision maker:** Muhammad Zia Uddin Attari. He approves every step and every merge.
- **Business analyst, architect, PM and QA:** Claude in a separate chat. It writes the specs and prompts you receive and reviews your work.
- **You:** build exactly what the spec says, in this repository, with tests.

If a spec is unclear, conflicts with these docs, or needs a business rule that is not written down: **stop and ask the CTO. Never invent a business rule.**

## What changed (30 Oct 2026)
The big Phase 2 system (NestJS + Postgres + Expo monorepo, "Sprint 0") is **on hold**. Its code is kept on the git branch `phase2-sprint0` and its docs in `docs/phase2/`. Do not work on it.

We are now building **Demo v1**: a small, free, web-only version that management can try. It must look premium and be very simple to use.

## Read first
1. `docs/demo-v1/01-scope.md` — users, screens, fields, business rules, acceptance criteria.
2. `docs/demo-v1/02-data-model.md` — MongoDB collections, indexes, calculations.
3. `docs/demo-v1/03-api.md` — every endpoint.
4. `docs/demo-v1/04-design-system.md` — Indigo + Sunehri tokens, fonts, components. Final design markup is in `docs/demo-v1/design/*.dc.html`.
5. `docs/demo-v1/05-deployment.md` — MongoDB Atlas + two Vercel projects.
6. The step prompt you were given (`docs/prompts/demo-N-*.md`). Do **one step at a time**, then stop and report.

## Repository layout (two separate apps — no monorepo tooling)
```
/frontend   Next.js (App Router) + TypeScript + Tailwind  → Vercel project "ushr-demo-web"  (Root Directory = frontend)
/backend    Node 24 + Express 5 + TypeScript + Mongoose   → Vercel project "ushr-demo-api"  (Root Directory = backend)
/docs       specs, prompts, design reference
CLAUDE.md, README.md, .gitignore
```
- Each folder has its **own** `package.json` and **own** `pnpm-lock.yaml`. There is **no** root `package.json`, no `pnpm-workspace.yaml`, no Turborepo. This keeps each Vercel project independent.
- The frontend never talks to MongoDB. Only the backend does.
- The browser calls the API at the **same origin** (`/api/...`). `frontend/next.config.ts` rewrites `/api/:path*` → `${BACKEND_URL}/api/:path*`. This keeps the session cookie first-party.

## Non-negotiable rules
1. **TypeScript strict** in both apps. No `any` without a comment.
2. **Validate every API input** with zod in the backend. Return the error shape `{ error: { code, message, details? } }` with stable `UPPER_SNAKE` codes.
3. **Access scope is enforced in the API**, never only in the UI. Every query on operational data filters by the caller's unit path prefix (see data model).
4. **No hard deletes** of jadwal data. Use `status`. Every submit / reopen / approve / password reset writes an `auditLogs` document.
5. **Dates:** a jadwal's `date` is the **Asia/Karachi** local date as `YYYY-MM-DD`. Timestamps are UTC `Date`. Never derive a local date from a UTC timestamp without the Karachi time zone.
6. **Money = integer rupees.** Never floats for money.
7. **No hard-coded rules.** Reward categories, reward tiers, periods, divisor, back-date days live in the `settings` collection (seeded with defaults).
8. **Reports are always calculated from records.** A day without a jadwal is "no record" — not zero, not leave.
9. **Language:** Zimmedar screens = **Urdu, RTL**, Western digits (0–9). Supervisor dashboard = **Roman Urdu, LTR**. All user-facing text lives in `frontend/src/i18n/ur.ts` and `frontend/src/i18n/roman.ts` — no hard-coded strings in components.
10. **Design:** final theme is **Indigo + Sunehri** (theme "indigo" in the design files). Use the tokens in `04-design-system.md`. Do not add the other two themes.
11. **Privacy & demo data:** all seed data is invented. Never put real people's names, ajeer codes or phone numbers in the repo. Never log passwords, tokens or full phone numbers.
12. **Secrets** only in `.env` files (git-ignored). Keep `.env.example` in each app updated with placeholders.
13. **Free-tier friendly:** MongoDB Atlas M0 (0.5 GB, 500 connections, 100 ops/s). Cache the Mongoose connection across serverless invocations; use `.lean()` and projections; aggregate with indexes. No file/photo uploads in Demo v1.

## Code conventions
- Backend: `backend/src/index.ts` default-exports the Express app (Vercel zero-config). Routes under `/api/v1`. One folder per module in `backend/src/modules/<name>/` with `routes.ts`, `service.ts`, `schemas.ts` (zod), `*.test.ts`.
- Frontend: App Router. Zimmedar area under `src/app/(app)/app/...` with `<html dir="rtl" lang="ur">` layout; dashboard under `src/app/(dash)/dashboard/...` LTR. Mobile-first (360–430 px) for the app area.
- Tests: backend Vitest + Supertest + `mongodb-memory-server`. Frontend: Playwright smoke test for the main flow (from Step 2 on).
- Commits: Conventional Commits (`feat(backend): …`, `fix(frontend): …`). Small commits.

## Definition of done (every step)
- All acceptance criteria in the step prompt pass.
- In both `frontend/` and `backend/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- `docs/demo-v1/*` updated if a field, endpoint or rule changed.
- Deployed to Vercel (both projects) and the CTO can try it on the live URL.
- A short report for the CTO in **Roman Urdu**: kya bana, kaise chalayein, kya baqi hai, kya sawal hain.

## Useful commands
```
# backend
cd backend && pnpm install && pnpm dev        # http://localhost:4000/api/v1/health
pnpm seed            # seeds demo data into MONGODB_URI (idempotent)
SEED_CONFIRM=ushr_demo pnpm seed --reset    # drops demo collections, then seeds (confirmation always required)
# PowerShell: $env:SEED_CONFIRM='ushr_demo'; pnpm seed --reset

# frontend
cd frontend && pnpm install && pnpm dev       # http://localhost:3000  (BACKEND_URL=http://localhost:4000)
```
