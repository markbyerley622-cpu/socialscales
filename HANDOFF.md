# Handoff

Where Social Scales is right now, what is proven, and the one action that
unblocks the next step.

For *why* things are the way they are, read `docs/DECISIONS.md`. For the
phase-by-phase build history, `docs/AI_PROGRESS.md`. This file is the current
state only.

**Last verified:** 2026-09-15 against the live deployment.

---

## State in one line

Production is live on Vercel, connected to a hosted Neon Postgres, serving real
database state with fixtures structurally impossible — and the database is
**empty**, because nothing has been created in it yet.

---

## Verified

| | |
|---|---|
| Repository | `github.com/markbyerley622-cpu/socialscales`, branch `main` |
| Local = remote = production | `38426f4` and later |
| Production URL | https://socialscales.vercel.app |
| Health | `/api/health` → `status: misconfigured` — `AUTH_COOKIE_SECRET` unset; see below |
| Data source | `mode: prisma`, `isDemo: false` |
| Database | Neon, reachable, 10 migrations applied |
| Row counts | `projects: 0, posts: 0, socialAccounts: 0, snapshots: 0` |
| Fixture hits across 11 production routes | **0** |
| Worker | `alive: false` — correct, none deployed |
| Gates | typecheck 0 · lint 0 · **316/316 tests** · build 0 · `prisma validate` ✅ |

Auto-deploy from `main` works. `/api/health` reports `build.commitShort`, so
confirming what production runs is one request — it previously took a 404 probe.

---

## The one thing blocking everything else

`AUTH_COOKIE_SECRET` is not set on Vercel, so **nobody can sign in** — and the
deployment cannot tell you that from the outside without this being fixed.

The operator exists (`npm run db:operator` was run against Neon successfully).
Authentication itself works: a correct password is verified, the session row is
written, `lastLoginAt` is stamped — and then `login` signs the session cookie,
reads the missing variable, and throws. The browser gets Next's static 500,
"This page couldn’t load / A server error occurred", with an error digest.

Every other signal said the deployment was fine, which is why this cost a
debugging cycle. A *wrong* password returned the ordinary "does not match",
because `authenticate` returns before any cookie is signed. `src/proxy.ts`
treats an absent secret as "no valid session" and quietly redirects every
protected route to `/login`. `/api/health` said `status: "ok"`.

**Set both secrets on Vercel** (Production scope), then redeploy:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # AUTH_COOKIE_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # SESSION_ENCRYPTION_KEY
```

`SESSION_ENCRYPTION_KEY` is not needed to sign in — only the worker's stored
browser profiles use it — but `PRODUCTION_ENV.md` requires both on both hosts,
and `/api/health` now checks both. Changing `AUTH_COOKIE_SECRET` later signs
everyone out.

`/api/health` reports this directly now: `auth.usable` is `false` and
`auth.problems` names the variable. A deployment nobody can sign in to returns
503 and does not call itself `ok`.

### And then: there is no way to create a project

Verified 2026-09-15 against an empty database with a working sign-in. A
freshly bootstrapped operator lands on `/onboarding`, which renders correctly —
and cannot be completed, because `saveOnboardingDraft` requires a Project and
throws `NOT_CONFIGURED` without one.

There is no Project-creation path anywhere in the product. The only
`prisma.project.create` in the repository is in `prisma/seed.ts`, which must
never run against production. `/ops/projects` shows "No projects yet. Run
`npm run db:seed` to create the three demo projects, or add one from Settings" —
the first half is actively dangerous advice in production and the second half is
false; Settings has no such form. The adapter interface has no create method
either.

So the next piece of work is a `prisma/create-project.ts` bootstrap in the shape
of `create-operator.ts` — one project, from values the operator supplies,
nothing else — plus corrected empty-state copy. Until then, an operator can sign
in and cannot use the product.

## What is finished after that, and what is not

### Finished once an operator exists and a project does

Sign-in, projects, brands, objectives, audiences, strategy, plans, briefs,
asset upload, analysis, copy variants, treatments, approvals, scheduling,
distribution assessment, the operator console at `/ops`, and the Social Scales
dashboard at `/`.

### Still required before a first real TikTok post

**1. A persistent worker.** Vercel cannot run it — the constraint is
architectural, not a setting. Rendering spawns `ffmpeg`, publishing drives
Playwright with a browser profile that must survive between runs, and both
outlive a serverless function.

Until one is attached, render and publish jobs **queue and wait**. They are not
lost and are never falsely marked complete; `/ops/renders` shows them unclaimed
and `/api/health` says `worker.alive: false`. That behaviour is verified end to
end locally.

`WORKER_DEPLOYMENT.md` has the host comparison (Railway recommended), the
Dockerfile, and the variables. **Nothing has been provisioned.** A laptop
running `npm run worker:once` against the production `DATABASE_URL` and
`REDIS_URL` is a legitimate way to prove the pipeline before paying for
anything.

**2. Redis.** BullMQ delivers jobs; Postgres holds them. The web app needs
`REDIS_URL` to enqueue and the worker needs it to consume. Without it a job row
is still written and simply waits.

**3. Shared object storage.** A cut rendered on the worker is not readable from
Vercel's ephemeral disk, so `/api/media/<key>` will 404 for anything the worker
produced. `MEDIA_STORAGE.md` classifies every file and defines the minimum
adapter. Cloudflare R2 recommended, on egress cost. **Nothing provisioned.**

---

## TikTok — blocked, deliberately

No TikTok work has been performed. The gate is:

- [x] production runs the intended commit
- [x] hosted Postgres connected, migrations applied
- [x] fixture fallback impossible in production
- [x] an operator exists
- [ ] sign-in works (`AUTH_COOKIE_SECRET` on Vercel)
- [ ] a project has been created (no path exists yet — see above)
- [ ] persistent worker attached
- [ ] shared media storage configured

TikTok also needs a throwaway account and a human sign-in — the system
deliberately cannot do that itself. Selectors in
`src/server/platforms/tiktok.ts` are written but have never run against the real
site; expect the first live run to break some, which is what the classified
failure reporting is for.

---

## Things that will bite you

**`prisma/seed.ts` is not for production.** See above.

**Two variables re-enable fixtures**, and only together:
`SOCIAL_SCALES_DATA_MODE=mock` *and* `SOCIAL_SCALES_ALLOW_DEMO=1`. Either alone
in a production build is refused. If demo data ever reappears, check those first.

**`DIRECT_URL` matters on pooled providers.** Neon puts PgBouncer in
transaction-pooling mode in front of the database, which is right for serverless
traffic and wrong for DDL. `prisma.config.ts` uses `DIRECT_URL` for migrations
when set and falls back to `DATABASE_URL`.

**Analytics are simulated until something publishes for real.** They are real
rows in a real database and still not measurements. `allSimulated` in
`/api/health` and a badge in the dashboard both say so, and the evidence model
refuses to promote them to account evidence.

**Every strategy is LOW confidence** and will stay that way until real results
exist. That is the confidence ceiling working, not a bug.

**Renders queue silently if BullMQ already holds a terminal job of the same id.**
Fixed in `render-service.ts`, but it is the kind of thing that looks like a
worker problem and is not.

---

## Verifying after any change

```bash
npm run typecheck && npm run lint && npm test && npm run build
curl -s https://socialscales.vercel.app/api/health | jq '{status, build, dataSource, auth, database, worker}'
```

`status` must be `ok`, `dataSource.isDemo` must be `false`, `auth.usable` must
be `true`, and `build.commitShort` must match what you pushed.

Check gates by **exit code**, not by reading output — `cmd | tail` returns
`tail`'s status, and a failing typecheck read as passing once already.

---

## Map

| Path | What |
|---|---|
| `src/app/(app)/` | Social Scales dashboard — the product |
| `src/app/(ops)/ops/` | Operator console — the engine room |
| `src/lib/social-scales/prisma-adapter.ts` | The only place the two vocabularies meet |
| `src/lib/social-scales/data-source.ts` | Why production cannot serve fixtures |
| `src/server/ai/orchestration/` | The single AI boundary |
| `src/server/rendering/` | EDL, FFmpeg provider, render runner |
| `src/server/distribution/` | Per-platform fit, automated and manual routes |
| `worker/index.ts` | The seven queue consumers |
| `PRODUCTION_ENV.md` | Every variable, where it goes, what breaks without it |
| `WORKER_DEPLOYMENT.md` | Why not Vercel, which host, the Dockerfile |
| `MEDIA_STORAGE.md` | File classification and the storage adapter |
