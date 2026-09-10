# Social Scales

An AI social-media operating system: strategy, planning, creative direction,
video rendering, publishing and learning — one Next.js app over one Postgres
database.

There are two surfaces in this repository, and they are deliberately different
things:

| Surface | Path | What it is |
| --- | --- | --- |
| **Dashboard** | `/` | The product. Clients, plan, content queue, studio, calendar, analytics, integrations. |
| **Operator console** | `/ops` | The engine room. Projects, evidence, strategy versions, briefs, renders, the publish queue, diagnostics. |

Both read the same database. The dashboard goes through
`PrismaSocialScalesAdapter`, which is the only place the product's vocabulary
(*client, content item, generation job*) meets the backend's (*project, post,
render job*). See `INTEGRATION.md`.

---

## Running it

```bash
cp .env.example .env.local     # then generate the two secrets it names
npm install
npm run db:up                  # Postgres + Redis in Docker
npx prisma migrate deploy
npm run db:seed
npm run dev                    # the app
npm run worker                 # the worker, in a second terminal
```

Sign in with `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` from `.env.local`.

The worker is not optional for anything that takes time: publishing, analytics
syncs and **video rendering** all run there, never in a request.

---

## What is real, and what is not

| Thing | State |
| --- | --- |
| Database, schema, migrations | Real |
| Upload, validation, fingerprinting, container probing | Real |
| Strategy, plans, briefs, evidence weighting | Real |
| **Video rendering** | **Real.** FFmpeg, 1080×1920 H.264/AAC, probed before it is accepted |
| Approval, scheduling, queues, retries, idempotency | Real |
| AI generation | **Inactive** without `ANTHROPIC_API_KEY`. Rules serve instead, labelled as rules |
| Publishing to a live platform | **Off by default** — a simulator runs instead |
| Analytics numbers | **Simulated** while publishing is simulated, and labelled as such everywhere |

That last row is load-bearing. `isDemoData` is true whenever the numbers behind a
view are simulated, and the dashboard renders a badge from it. Nothing in this
system reports a simulated number as a measured one.

---

## The pipeline

```
raw assets ──> analysis ──> strategy ──> plan ──> briefs
                                                   │
                                                   ▼
                                          variants + treatments
                                                   │
                                                   ▼
                                    render (FFmpeg) ──> 9:16 MP4
                                                   │
                                                   ▼
                                distribution ──> automated publish
                                             └─> manual export
                                                   │
                                                   ▼
                                    analytics ──> evidence ──> learnings
                                                                  │
                                                       feeds back into strategy
```

Every step is traceable backwards: a published post names the brief that asked
for it, the brief names the strategy decision it serves, and the decision names
the evidence behind it — with the four evidence classes (this account,
experiment, external, general prior) never merged.

---

## Documentation

| File | What it covers |
| --- | --- |
| `INTEGRATION.md` | The adapter seam, the contract, and how the two surfaces were merged |
| `docs/DOMAIN.md` | The domain model, evidence classes, weighting, rendering, distribution |
| `docs/DECISIONS.md` | Non-obvious choices, why they were made, what they cost |
| `docs/AI_PROGRESS.md` | Current state, what is proven, what is not, what is next |

---

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection |
| `REDIS_URL` | no | BullMQ. Default `redis://localhost:56379` |
| `SESSION_ENCRYPTION_KEY` | yes | 32 bytes hex. Encrypts stored browser sessions |
| `AUTH_COOKIE_SECRET` | yes | Signs the operator session cookie |
| `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` / `OPERATOR_NAME` | seed only | The seeded operator account |
| `SOCIAL_SCALES_DATA_MODE` | no | `prisma` (default), `mock`, or `http` |
| `ANTHROPIC_API_KEY` | no | Leave blank to run entirely on rules |
| `AI_MODEL_PROVIDER` | no | `auto` (default), `deterministic`, or `anthropic` |
| `ENABLE_LIVE_PUBLISHING` | no | `1` to drive real browsers against real accounts |
| `PLAYWRIGHT_HEADLESS` | no | Must be `0` to connect an account by hand |
| `FFMPEG_PATH` / `FFPROBE_PATH` | no | If FFmpeg is not on PATH |
| `RENDER_FONT_FILE` | no | A `.ttf` for burned-in captions |
| `STORAGE_DIR` | no | Where media and artefacts are written. Default `./storage` |

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # SESSION_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # AUTH_COOKIE_SECRET
```

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | The app |
| `npm run worker` | Publishing, analytics and rendering |
| `npm test` | 307 tests, including real FFmpeg renders |
| `npm run typecheck` / `npm run lint` / `npm run build` | The gates |
| `npm run db:migrate` / `db:seed` / `db:studio` | Database |
