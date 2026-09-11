# Worker deployment

The worker is a long-lived process. Vercel cannot run it, and no amount of
configuration will change that — the constraint is architectural, not a setting.

---

## What the worker is

`worker/index.ts`, started with `npm run worker:once` (the `worker` script adds
`--watch`, which is for development only).

It opens seven BullMQ consumers — `content-analysis`, `publishing`,
`analytics-sync`, `trend-discovery`, `recommendations`, `accounts`, `rendering`
— plus three in-process timers: a heartbeat, a due-job sweeper, and a session
prune.

| Property | Behaviour |
|---|---|
| Claim | BullMQ's own atomic lock. `rendering` holds it for 30 minutes, `publishing` for 10. |
| Concurrency | `rendering` and `publishing` are 1; analysis 4; analytics 2. FFmpeg saturates a CPU alone, and a platform is entitled to one action at a time from an account. |
| Retries | 3 attempts, exponential backoff from 30s — but only for failures the runner classifies as retryable. A missing asset or an out-of-range trim fails once. |
| Duplicate protection | A custom BullMQ job id, plus a `RenderJob.idempotencyKey` derived from the cut itself. Two workers cannot double-render; a retry reuses the same output path. |
| Crash recovery | `reclaimStaleRenders()` returns `RUNNING` jobs with no recent heartbeat to `PENDING`, bounded at 3 attempts. A worker killed after the encode but before the row was written adopts the finished file rather than re-encoding. |
| Shutdown | `SIGINT`/`SIGTERM` close every consumer, so an in-flight job finishes or is released rather than being abandoned. |
| Heartbeat | `WorkerStatus` row every 60s: id, hostname, start time, last seen, effective publishing mode. Surfaced at `/api/health` → `worker`. |

---

## Why not Vercel

| Requirement | Serverless |
|---|---|
| Process that outlives a request | No. Functions are killed when the response ends. |
| `ffmpeg` / `ffprobe` binaries | Not in the runtime. |
| Encodes longer than the function timeout | A render is minutes. |
| Playwright + a real Chromium with a persistent profile | Not supported; the profile must survive between runs. |
| A writable disk that persists | Serverless disks are ephemeral. |

The web app on Vercel is still a real read/write console over real data. Only
rendering and publishing need somewhere else. Queued jobs wait — `/ops/renders`
shows them unclaimed and `/api/health` says `worker.alive: false`. **Nothing is
lost while no worker is running.**

---

## Choosing a host

Judged against what this code actually needs, not on popularity.

| | Railway | Render (Background Worker) | Fly.io | A plain VM |
|---|---|---|---|---|
| Long-lived process | ✅ | ✅ | ✅ | ✅ |
| Dockerfile | ✅ | ✅ | ✅ | ✅ |
| FFmpeg | via Docker | via Docker | via Docker | apt |
| Playwright + Chromium | via Docker | via Docker | via Docker | apt |
| Persistent disk for the browser profile | volume | disk | volume | native |
| Managed Postgres alongside | ✅ | ✅ | ✅ | — |
| Managed Redis alongside | ✅ | ✅ | ✅ (Upstash) | — |
| Free/dev tier | trial credit | free tier (spins down) | trial credit | — |
| Setup effort | lowest | low | medium | highest |

**Recommendation: Railway.** It is the only option that provisions Postgres,
Redis and a Dockerfile-based worker in one project with one set of shared
environment variables — which matters here because the web app and the worker
must agree on `DATABASE_URL`, `REDIS_URL` and `QUEUE_PREFIX` exactly. Render's
free tier spins background workers down, which defeats the purpose. Fly is a
good fit technically but is more moving parts for the same result.

This is a recommendation, not a decision made on your behalf — **no paid
resource has been created.**

---

## The Dockerfile the worker needs

Not committed, because committing a Dockerfile implies a chosen host. Create it
at the repository root when you pick one:

```dockerfile
# Playwright's image already carries Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate

# No --watch: that is the development script.
CMD ["npm", "run", "worker:once"]
```

`postinstall` runs `prisma generate`, so the generated client is present after
`npm ci`; the explicit call is belt and braces after the schema is copied.

---

## Deploying to Railway

```bash
npm i -g @railway/cli
railway login                 # opens a browser — you must do this
railway init                  # or: railway link   (existing project)

# Postgres and Redis in the same project, so they share a private network.
railway add --database postgres
railway add --database redis

# The worker service, built from the Dockerfile above.
railway up --service worker
```

Then set the worker's variables — Railway exposes the managed services as
`${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}`:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `SESSION_ENCRYPTION_KEY` | same value as Vercel |
| `AUTH_COOKIE_SECRET` | same value as Vercel |
| `QUEUE_PREFIX` | `bull` (same as Vercel) |
| `ENABLE_LIVE_PUBLISHING` | `0` until TikTok work begins |
| `STORAGE_DIR` | `/data/storage` on a mounted volume |

**The same `DATABASE_URL` and `REDIS_URL` must then be set in Vercel.** One
source of truth means one database and one queue, not two of each.

---

## Verifying the worker

```bash
curl -s https://<deployment>/api/health | jq '.worker'
```

```json
{ "alive": true, "hostname": "worker-xxxx", "heartbeatAgeSeconds": 12, "livePublishing": false }
```

`alive` goes false after two missed heartbeats (120s). Then queue a render from
`/ops/renders` and watch `renderQueue.queued` fall to zero as the worker claims
it. The worker log names the same job id the row does.

---

## Running it locally instead

Entirely valid while there is no worker host. The worker only needs to reach the
same Postgres and Redis:

```bash
DATABASE_URL=<hosted postgres> REDIS_URL=<hosted redis> npm run worker:once
```

Jobs queued in production will be claimed by that laptop. Useful for proving the
pipeline before paying for anything — and honest, because `/api/health` reports
the worker's real hostname.
