# Production environment

Every variable this system reads, where it belongs, and what happens without it.

No secret values appear in this file, and none belong in Git. `.env`,
`.env.local` and `.env*.local` are gitignored; only `.env.example` is tracked,
and it contains placeholders.

**Where "both" appears, the value must be identical in both places.** The web app
and the worker share one database and one queue; a mismatch means two systems
that each think they are the only one.

---

## REQUIRED — the app will not serve real data without these

| Variable | Where | Purpose | Format | Restart |
|---|---|---|---|---|
| `DATABASE_URL` | **both** | The single source of truth. Must be reachable *from the host* — a `localhost` URL works on your laptop and never on Vercel. | `postgresql://user:pass@host:5432/db?sslmode=require` | redeploy / restart |
| `SESSION_ENCRYPTION_KEY` | **both** | Encrypts stored browser-session material at rest. | 64 hex chars (32 bytes) | redeploy / restart |
| `AUTH_COOKIE_SECRET` | **both** | HMACs the operator session cookie. Changing it signs everyone out. | 64+ char random string | redeploy / restart |

### `DIRECT_URL` — required only on pooled providers

| Variable | Where | Purpose | Format |
|---|---|---|---|
| `DIRECT_URL` | migrations only | A **non-pooled** connection for `prisma migrate deploy`. | `postgresql://user:pass@host:5432/db?sslmode=require` |

Neon, Supabase and Vercel Postgres put PgBouncer in front of the database in
transaction-pooling mode. That is correct for serverless request traffic and
wrong for DDL: `prisma migrate deploy` needs session-level features a transaction
pooler does not provide, and fails in ways that look like network errors.

`prisma.config.ts` uses `DIRECT_URL` when set and `DATABASE_URL` when not, so a
single-URL provider needs no extra configuration. If your provider gives you both
a pooled and a direct string, use the pooled one for `DATABASE_URL` and the
direct one for `DIRECT_URL`.

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # SESSION_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # AUTH_COOKIE_SECRET
```

Without `DATABASE_URL` the build still succeeds and the deployment still ships —
deliberately. It then reports `status: "misconfigured"` on `/api/health`, and
Settings shows **"Backend unavailable — this deployment is not configured"**.
It does **not** fall back to fixtures.

That behaviour is the point. An earlier version threw while *building*, which
meant a misconfigured deploy never shipped and the host kept serving the last
build that worked — a stale bundle quietly showing demo data. Failing at request
time is louder and cannot be mistaken for a working system.

---

## WORKER-ONLY — rendering and publishing

The worker is a long-lived process. It cannot run on Vercel. See
`WORKER_DEPLOYMENT.md`.

| Variable | Purpose | Format | Notes |
|---|---|---|---|
| `REDIS_URL` | BullMQ transport. Postgres holds the job rows; Redis delivers them. | `redis://…` / `rediss://…` | **Also needed by the web app** so it can enqueue. Without it a job row is still written and simply waits. |
| `QUEUE_PREFIX` | Redis key namespace. | `bull` | Must match between web and worker, or each sees an empty queue. |
| `ENABLE_LIVE_PUBLISHING` | `1` drives real browsers against real accounts. Anything else runs the simulator. | `0` / `1` | Worker's value wins; the console reports the worker's, not its own. |
| `PLAYWRIGHT_HEADLESS` | Must be `0` to connect an account by hand. | `0` / `1` | Connecting needs a visible window and a person. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Only if the binaries are not on `PATH`. | absolute path | |
| `RENDER_FONT_FILE` | `.ttf` for burned-in captions. Auto-detected on Windows/macOS/Linux. | absolute path | Set it if a render fails `FONT_UNAVAILABLE`. |
| `STORAGE_DIR` | Where media is written. | `./storage` | See `MEDIA_STORAGE.md` — local disk is not shareable. |

---

## OPTIONAL

| Variable | Where | Purpose | Default |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | both | Enables model-generated strategy, plans, treatments and copy. Absent means rules, labelled as rules. | unset |
| `AI_MODEL_PROVIDER` | both | `auto` (model if a key exists, else rules), `deterministic`, `anthropic` (fail rather than substitute). | `auto` |
| `AI_MODEL` | both | | `claude-opus-5` |
| `AI_MAX_REPAIRS` / `AI_MAX_RETRIES` / `AI_REQUEST_TIMEOUT_MS` | both | Schema-repair and transport budgets. | `2` / `2` / `120000` |
| `SIMULATED_FAILURE_RATE` | worker | Fraction of first publish attempts the simulator fails, so the retry path stays reachable. | `0.125` |
| `TEST_DATABASE_URL` | local | Overrides the derived `<db>_test` database. | derived |

---

## DEMO-ONLY — do not set in a real deployment

| Variable | Purpose |
|---|---|
| `SOCIAL_SCALES_DATA_MODE` | `prisma` (default), `http`, or `mock`. **Leave unset in production.** |
| `SOCIAL_SCALES_ALLOW_DEMO` | `1` permits `mock` in a production build. Without it, `mock` is refused. |
| `NEXT_PUBLIC_SOCIAL_SCALES_API_URL` | Only for `http` mode — a split deployment. |
| `SOCIAL_SCALES_API_TOKEN` | Bearer token for `http` mode. |

`SOCIAL_SCALES_DATA_MODE=mock` is what served ClipPilot AI, Peak Studio, Nexa
Fitness and Lumen Brand. It was the standalone frontend's documented default.
**If it exists in the deployment environment, delete it.**

A deliberate demo deployment needs *both* `SOCIAL_SCALES_DATA_MODE=mock` and
`SOCIAL_SCALES_ALLOW_DEMO=1`. It then reports `status: "demo"` on `/api/health`
with HTTP 503, and Settings says "Development fixtures" with a warning that
nothing on the deployment is real.

---

## SECRETS

Treat as secret and never commit: `DATABASE_URL` (contains a password),
`SESSION_ENCRYPTION_KEY`, `AUTH_COOKIE_SECRET`, `REDIS_URL` (usually contains a
password), `ANTHROPIC_API_KEY`, `SOCIAL_SCALES_API_TOKEN`.

Not secret: `NODE_ENV`, `QUEUE_PREFIX`, `STORAGE_DIR`, the `AI_*` tuning values,
`SOCIAL_SCALES_DATA_MODE`, and the build metadata Vercel injects
(`VERCEL_GIT_COMMIT_SHA` and friends) — a commit SHA is already public.

---

## Injected by the host — do not set by hand

| Variable | Set by | Used for |
|---|---|---|
| `VERCEL_GIT_COMMIT_SHA` | Vercel | `/api/health` → `build.commit`, so a deployment can prove which commit it runs |
| `VERCEL_GIT_COMMIT_REF` | Vercel | branch |
| `VERCEL_ENV` | Vercel | `production` / `preview` / `development` |
| `GIT_COMMIT_SHA` / `GIT_BRANCH` | other hosts | Same purpose. Set these in a non-Vercel build step to keep the guarantee. |

---

## Verifying

```bash
curl -s https://<deployment>/api/health | jq '{status, build, dataSource, database, worker}'
```

| Field | Must be |
|---|---|
| `status` | `"ok"` |
| `build.commitShort` | the commit you intended to deploy |
| `dataSource.mode` | `"prisma"` |
| `dataSource.isDemo` | `false` |
| `database.reachable` | `true` |
| `worker.alive` | `true` once a worker is deployed; `false` is honest and means jobs queue |
