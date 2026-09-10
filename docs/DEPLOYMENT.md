# Deployment

What a hosted deployment needs, what it cannot do, and how to prove it is
serving real data.

---

## The rule

**Production never shows fixtures.** `resolveDataSource()` refuses
`SOCIAL_SCALES_DATA_MODE=mock` in a production build unless
`SOCIAL_SCALES_ALLOW_DEMO=1` is also set, and a misconfigured source throws
rather than falling back.

That is not a stylistic preference. Fixture data — invented clients, invented
connection statuses, invented analytics — is indistinguishable at a glance from
a working system, and it is acted on by mistake. An error page cannot be.

---

## Required environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres the deployment can actually reach. A `localhost` URL is not reachable from a hosted platform. |
| `SESSION_ENCRYPTION_KEY` | **yes** | 32 bytes hex. `src/env.ts` throws at import without it, so the build fails rather than shipping broken. |
| `AUTH_COOKIE_SECRET` | **yes** | Signs the session cookie. Same failure mode. |
| `SOCIAL_SCALES_DATA_MODE` | no | `prisma` (default), `http`, or `mock`. **Leave it unset in production.** |
| `SOCIAL_SCALES_ALLOW_DEMO` | no | `1` only if a deployment is deliberately a demo. |
| `REDIS_URL` | worker only | Queues. The web app degrades without it; the worker does not run. |
| `ANTHROPIC_API_KEY` | no | Absent means rules, labelled as rules. |
| `STORAGE_DIR` | no | Local filesystem. See the limitations below. |

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # SESSION_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # AUTH_COOKIE_SECRET
```

---

## What a serverless host can and cannot run

This repository is one Next.js app plus a long-running worker. Vercel and
equivalents run the first and **cannot run the second**.

| Part | Serverless host | Why |
|---|---|---|
| Dashboard and console (reads/writes) | ✅ | Ordinary requests against Postgres |
| Auth, approvals, scheduling | ✅ | Same |
| **Publish worker** | ❌ | A long-lived BullMQ consumer; there is no process to keep alive |
| **Video rendering** | ❌ | Spawns `ffmpeg`; the binary is not in the runtime and encodes outrun the function timeout |
| **Browser publishing** | ❌ | Drives Playwright against a real browser profile |
| **Media storage** | ❌ | `STORAGE_DIR` is a local filesystem; serverless disks are ephemeral |

So a hosted deployment of the web app is a **real, read-and-write console over
real data** — but rendering and publishing need a machine that stays running: a
VM, a container host, or a developer's laptop with `npm run worker`. Queued
render and publish jobs simply wait until a worker connects; nothing is lost.

Nothing in the app pretends otherwise. `/ops/renders` shows queued jobs sitting
unclaimed, and the settings screen reports the worker's real state.

---

## Verifying a deployment

One request, no browser, no credentials:

```bash
curl -s https://<your-deployment>/api/health | jq
```

Healthy, on real data:

```json
{
  "status": "ok",
  "dataSource": { "mode": "prisma", "usable": true, "isDemo": false },
  "database": { "reachable": true, "projects": 3, "posts": 89, "socialAccounts": 3 },
  "analytics": { "snapshots": 463, "allSimulated": true }
}
```

What the fields mean:

- `dataSource.mode` — `prisma` is the database. `mock` means fixtures.
- `dataSource.isDemo` — **if this is `true`, nothing on the site is real.**
- `database.projects` — non-zero proves a real database, not fixtures.
- `analytics.allSimulated` — `true` means the numbers are simulated. They are
  real rows in a real database and still not measurements; the dashboard shows a
  demo badge for exactly this.

Failure responses are `503` and name the problem:

```json
{ "status": "misconfigured",
  "dataSource": { "mode": "mock", "usable": false,
    "problem": "SOCIAL_SCALES_DATA_MODE=mock is set in a production build..." } }
```

```json
{ "status": "database-unreachable",
  "database": { "reachable": false, "problem": "..." } }
```

Then confirm by eye:

| Check | Where |
|---|---|
| Settings → Advanced → Data source | Must say **Live database**, not "Development fixtures" |
| Integrations | Must list real `SocialAccount` rows, not `@clippilot` |
| Dashboard clients | Must be your projects, not ClipPilot AI / Peak Studio / Nexa Fitness / Lumen Brand |
| `/ops` | Must load. If it 404s, the deployment predates the merge |

That last row is the fastest test of all: `/ops` and `/login` exist only in the
merged app.

---

## First deploy checklist

1. Provision Postgres and copy its connection string.
2. Run migrations against it: `DATABASE_URL=<url> npx prisma migrate deploy`.
3. Set `DATABASE_URL`, `SESSION_ENCRYPTION_KEY`, `AUTH_COOKIE_SECRET`.
4. **Delete any `SOCIAL_SCALES_DATA_MODE` variable** left over from the
   standalone frontend deployment. This is the one that served fixtures.
5. Seed an operator, or the login page has no account to accept:
   `DATABASE_URL=<url> OPERATOR_EMAIL=… OPERATOR_PASSWORD=… npm run db:seed`.
6. Deploy, then `curl /api/health` and check `isDemo` is `false`.
7. Run `npm run worker` somewhere persistent if you want renders and publishing.
