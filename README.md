# CONTENT OS

An internal content distribution and experimentation console.

You make the content. This system organises it, drafts the metadata around it,
schedules it, publishes it through approved automation, collects what happened,
and turns that history into evidence about what actually works for *your*
accounts.

```
CONTENT → REVIEW → SCHEDULE → PUBLISH → MEASURE → LEARN → BETTER CONTENT
```

It is deliberately not a growth-hacking tool. There is no engagement
manipulation, no bot behaviour, and no invented "viral score" — see
[Deliberate limits](#deliberate-limits).

---

## Quick start

```bash
# 1. Infrastructure (Postgres 16 + Redis 7, on non-default ports)
npm run db:up

# 2. Environment
cp .env.example .env.local          # then generate the two secrets it names

# 3. Schema + demo data
npm run db:migrate
npm run db:seed

# 4. Two processes
npm run dev                          # the console, http://localhost:3000
npm run worker                       # the job worker (separate terminal)
```

Sign in with `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` from `.env.local`.

The seed creates three projects (**Creator AI**, **University AI**, **Travel
AI**) with roughly seven weeks of publishing history, so the analytics and
learning screens have real data to compute over from the first page load.

### Requirements

Node 20.9+ (developed on 24), Docker, and nothing else. No ffmpeg, no cloud
account, no API keys.

---

## What is real, and what is simulated

This distinction is enforced in the product, not just in this README.

| Thing | State |
|---|---|
| Database, schema, migrations | Real |
| Upload, validation, fingerprinting, container probing | Real |
| AI metadata generation | Real, local heuristics (`AI_PROVIDER=heuristic`) |
| Approval, scheduling, queues, retries, idempotency | Real |
| Publishing to a live platform | **Off by default** — the simulator runs instead |
| Analytics numbers | **Simulated** while publishing is simulated, and labelled as such everywhere |
| The learning engine | Real maths over whatever data is present |

With `ENABLE_LIVE_PUBLISHING` unset, the publishing worker runs a simulator that
walks the same steps, writes the same logs and returns the same result shape as
a real browser run. The whole pipeline — queue, claim, retry, idempotency, status
transitions, activity log, analytics — is therefore exercisable end to end
without touching a live account.

Every metric produced that way is stored with `source = SIMULATED` and the UI
badges it. Simulated numbers can never be mistaken for platform data.

---

## Architecture

```
┌─ Next.js 16 (App Router, RSC) ──────────────────────────────┐
│  app/(app)          console pages, all server-rendered      │
│  app/actions        server actions (each re-checks auth)    │
│  app/api            upload + authenticated media serving    │
│  proxy.ts           cheap cookie gate before every request  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌─ src/server ─────────────┴──────────────────────────────────┐
│  auth/         opaque sessions, scrypt passwords            │
│  media/        magic-byte validation, pure-JS MP4/PNG probe │
│  storage/      local FS behind a 4-function key interface   │
│  ai/           AiProvider interface + heuristic provider    │
│  platforms/    SocialPlatform adapters + registry           │
│  automation/   Playwright sessions, publish runner, simulator│
│  services/     content, posts, publishing                   │
│  analytics/    append-only snapshots + read models          │
│  learning/     dimension analysis, recommendations, trends  │
│  jobs/         BullMQ queue definitions                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                worker/index.ts  ── 6 queues + sweeper
                           │
        Postgres (truth)   ·   Redis (delivery)
```

**Postgres is the source of truth; Redis is only delivery.** Every queued job has
a `PublishJob` row. If Redis is wiped, the sweeper re-queues everything due and
nothing publishes twice, because the duplicate guard is a database constraint.

### The platform boundary

The scheduler, approval flow and worker never mention TikTok, Instagram or
YouTube by name. They ask the registry for a `SocialPlatform` and read its
declared capabilities. Adding a platform is one adapter file plus one registry
entry.

Each adapter declares, per operation, whether it is `OFFICIAL_API`,
`BROWSER_ASSISTED` or `UNSUPPORTED` — and the Accounts and Settings screens
render that matrix directly from the code, so the documentation cannot drift.

#### API vs browser-assisted, as shipped

| Platform | Upload | Publish | Own scheduler | Metrics |
|---|---|---|---|---|
| TikTok | Browser-assisted | Browser-assisted | Browser-assisted | Browser-assisted |
| Instagram | Browser-assisted | Browser-assisted | **Unsupported** | Browser-assisted |
| YouTube | Browser-assisted | Browser-assisted | Browser-assisted | Browser-assisted |

Where an official API exists it is the better route, and neither is configured
here:

- **YouTube** has a fully documented upload API (`youtube.videos.insert`) that
  also supports scheduled publishing. It needs a Google Cloud project, OAuth
  consent and a per-channel refresh token. This is the first platform worth
  switching over.
- **Instagram**'s supported path is the Graph API, requiring a Business/Creator
  account linked to a Facebook Page plus an approved Meta app.
- **TikTok**'s Content Posting API requires an approved developer application
  per account.

`capabilities` reports what is *implemented*, not what is possible. Switching a
platform to its API means implementing one method and flipping the entries —
nothing outside that adapter file changes.

### Account connection

"Connect" queues a job on the worker, which opens a real Chromium window at the
platform's own login page. **You** type the credentials and complete whatever
verification is asked for. This system never fills a login form, never sees a
password and never stores one. Only the resulting Playwright `storageState` is
kept, AES-256-GCM encrypted with `SESSION_ENCRYPTION_KEY`.

---

## The learning engine

This is the part that gets more valuable the longer you run it. It answers one
question per dimension: *given what this account has actually published, which
choices beat this account's own median?*

Dimensions: **hook pattern**, **format**, **posting window**, **runtime**, **CTA**.

Three rules keep it honest:

1. **Comparisons are always against the project's own median**, never an
   invented industry benchmark.
2. **Confidence is a stated function of sample size and effect size.** HIGH needs
   ≥8 posts in the group and a ≥25% effect; MEDIUM needs ≥4 and ≥15%. Below 12
   published posts in a project, nothing rises above LOW no matter how large the
   apparent lift. Every figure carries the reasoning for its own confidence.
3. **Posts are only compared at the same age.** A post read at its 7-day window
   against one read at 30 days is an age difference wearing a performance
   costume, so anything comparative pins every post to one window.

### Performance estimate, not a viral score

The per-variant estimate is the product of the per-dimension lifts, and:

- only dimensions at MEDIUM or better contribute — a LOW dimension appears in the
  basis with a lift of exactly 1.0 so it visibly moves nothing;
- group lifts are **halved** before compounding, so three moderate signals cannot
  multiply into an extraordinary claim;
- overall confidence is the **weakest** contributing dimension, never the
  strongest;
- the basis is always shown: which dimension, which group, what lift, what n.

Writing scorecards (hook / clarity / curiosity / CTA / trend fit) are labelled
"writing heuristics — not a prediction" and are kept visually and conceptually
separate from the evidence-based estimate.

### Trends

No external trend source is connected, and none of these platforms expose
trending data to an unapproved application. Rather than scrape or fabricate, the
Trends page surfaces movement within **your own** hashtags, measured against your
own earlier results, and labels every row `local-history`. Adding a real source
means implementing one function with the same return shape.

---

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection |
| `REDIS_URL` | no | BullMQ. Default `redis://localhost:56379` |
| `SESSION_ENCRYPTION_KEY` | yes | 32 bytes hex. Encrypts stored browser sessions |
| `AUTH_COOKIE_SECRET` | yes | Signs the operator session cookie |
| `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` / `OPERATOR_NAME` | seed only | The seeded operator account |
| `STORAGE_DIR` | no | Where media and artefacts are written. Default `./storage` |
| `AI_PROVIDER` | no | `heuristic` (default) |
| `ENABLE_LIVE_PUBLISHING` | no | `1` to drive real browsers against real accounts |
| `PLAYWRIGHT_HEADLESS` | no | Must be `0` to connect an account by hand |
| `TEST_DATABASE_URL` | no | Overrides the derived `<db>_test` database |

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # SESSION_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # AUTH_COOKIE_SECRET
```

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Console at :3000 |
| `npm run worker` | Job worker (watch mode) |
| `npm test` | Full suite, isolated `<db>_test` database |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run db:up` / `db:down` | Postgres + Redis |
| `npm run db:migrate` / `db:reset` / `db:seed` / `db:studio` | Schema and data |

### Tests

79 tests over two suites: pure logic (validation, probing, crypto, adapters,
approval policy, confidence maths) and integration against a real database
(upload, dedupe, analysis, approval, publishing, duplicate prevention, analytics
windows, recommendations, auth).

They run against a **separate database** whose name ends in `_test`, created
automatically. `resetDatabase` asks the server which database it is actually
connected to and refuses to truncate anything else — Prisma's `?schema=`
parameter is honoured by the CLI but ignored by the driver adapter, and that
mismatch will happily destroy your development data if nothing checks.

No social account, Redis instance or browser is needed to run them.

---

## Security

- Passwords: scrypt (N=2¹⁵), never stored or logged in plaintext.
- Sessions: opaque random tokens; only a SHA-256 hash is persisted. The cookie is
  `httpOnly`, `SameSite=Lax`, HMAC-signed so forged cookies are rejected without
  a database hit.
- Platform sessions: AES-256-GCM at rest. No passwords, ever.
- Every server action and route handler re-checks the session — server actions
  are POST endpoints, so a page-level guard is not sufficient.
- Uploads are accepted on sniffed magic bytes, not the declared MIME type or
  extension, with per-type size ceilings.
- Media is served only to a signed-in session, and only for keys that exist in
  the database.
- Login is rate limited per client address.
- Everything meaningful is written to an append-only activity log.

---

## Deliberate limits

Not implemented, on purpose:

- No CAPTCHA solving or challenge bypass
- No browser fingerprint spoofing or stealth plugins
- No purchased views, likes or followers
- No automated commenting, following or liking
- No mass DMs, no account creation
- No scraping of private data
- No predicted virality score

If a platform presents a verification step mid-publish, the run fails, preserves
a screenshot of what it saw, and asks a person to finish it.

---

## Known limitations

1. **Live publishing is unverified against real platforms.** The adapters carry
   real URLs and multi-candidate selector strategies, but they have only been
   exercised against the simulator. Platform DOMs drift; expect to fix selectors.
2. **No transcription.** The heuristic provider reads the filename, the content
   pillar and the probed container facts. It says so rather than inventing a
   transcript.
3. **WebM duration is not probed.** MP4/MOV/PNG/JPEG are; WebM reports `null`
   rather than a guess.
4. **Analytics collection from live platforms is not implemented.** The
   `collectMetrics` hook exists on the adapter interface and is unimplemented.
5. **Single operator.** The schema carries roles and the audit trail is per-user,
   but there is no invite flow or per-project membership yet.
6. **Storage is local disk.** Swapping in S3 means implementing the same
   four-function interface in `src/server/storage`.
7. **Timezones.** Projects carry a timezone and schedule slots are stored as
   local minutes, but publish times are handled in server-local time. A team
   spread across zones would want that tightened.
8. **The rate limiter is process-local**, which is right for one instance and
   wrong for several.
