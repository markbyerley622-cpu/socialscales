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
| Local = remote = production | `fb65b0c` |
| Production URL | https://socialscales.vercel.app |
| Health | `/api/health` → `status: ok` |
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

The production database has no operator, so nobody can sign in, so no project
exists, so nothing can be rendered or published.

**Run this.** It needs your Neon URL, which is deliberately not stored here or
anywhere in the repository:

```bash
DATABASE_URL="<your Neon pooled URL>" \
OPERATOR_EMAIL="you@example.com" \
OPERATOR_PASSWORD="<at least 12 characters>" \
npm run db:operator
```

Then sign in at `/login` and create a project at `/ops/projects`.

`prisma/create-operator.ts` creates one workspace and one user and nothing else.
It is **not** `prisma/seed.ts`, which builds a 719-line demonstration dataset —
projects, posts, publish jobs, experiments — and must never be run against
production.

---

## What is finished after that, and what is not

### Finished once an operator exists

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
- [ ] an operator exists and a project has been created
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
curl -s https://socialscales.vercel.app/api/health | jq '{status, build, dataSource, database, worker}'
```

`status` must be `ok`, `dataSource.isDemo` must be `false`, and
`build.commitShort` must match what you pushed.

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
