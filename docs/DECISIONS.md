# Decisions

Non-obvious choices, why they were made, and what they cost. Newest last.

---

## 2026-09-10 · Single Next app with a server layer, not a monorepo

**Context.** The brief asks for clear separation between UI, database, jobs,
platform adapters, analytics, the recommendation engine, browser automation, AI
services and storage.

**Decision.** One Next.js app with a strict `src/server/*` module layout, plus a
separate worker entry point that imports the same modules.

**Alternatives.** A pnpm workspace with one package per concern.

**Rationale.** The separation the brief cares about is a *dependency* boundary,
and module structure enforces that just as well as package boundaries at this
size. A workspace would have added install complexity and Windows path friction
for no boundary that is not already enforced.

**Consequences.** Nothing stops an import from crossing a layer except review.
If the worker is ever deployed separately from the web app, this becomes a real
split rather than a directory move.

---

## 2026-09-10 · Hand-rolled auth instead of a library

**Decision.** Opaque session tokens in Postgres, scrypt password hashing from
`node:crypto`, an HMAC-signed `httpOnly` cookie.

**Alternatives.** Auth.js v5.

**Rationale.** The requirement is one operator account. Auth.js at the time of
writing is a fast-moving beta whose API is past the point where its behaviour can
be assumed; misconfiguring it is a more realistic risk than getting an opaque
token wrong. scrypt avoids a native build step for argon2/bcrypt on Windows.

**Consequences.** No OAuth providers without real work. If SSO is ever needed,
this is the thing to replace.

---

## 2026-09-10 · scrypt with an explicit `maxmem`

**Context.** N=2¹⁵, r=8 requires 128·N·r = exactly 32 MiB, which is precisely
Node's default `maxmem` ceiling — so it fails.

**Decision.** Raise `maxmem` to 64 MiB rather than lower the work factor.
Verification also accepts a larger ceiling derived from the stored parameters, so
a hash created with stronger settings still verifies.

---

## 2026-09-10 · Pure-JS container probing, no ffmpeg

**Decision.** Parse ISO-BMFF boxes (`mvhd`, `tkhd`, `hdlr`) and PNG/JPEG headers
directly for duration, dimensions, aspect ratio and audio presence.

**Alternatives.** Shell out to ffprobe.

**Rationale.** Zero install burden, and these are exactly the four facts that
decide whether a platform will accept a file. Values are read from the bytes, so
they are real rather than assumed.

**Consequences.** WebM duration is not available and is reported as `null`
instead of a guess. Anything beyond these four facts needs a real decoder.

---

## 2026-09-10 · Charts hand-drawn as inline SVG

**Decision.** Drop Recharts; render the area chart, diverging lift bars and
sparklines as inline SVG in small client components.

**Rationale.** Three chart forms did not justify a charting dependency whose
current major version is past reliable knowledge. Hand-drawing also makes the
data-viz mark specs exact: 2px lines, hairline grid, one axis, direct labels,
4px rounded data-ends, a real crosshair.

**Consequences.** A fourth or fifth chart form would change this calculus.

---

## 2026-09-10 · Colour palette validated, not chosen by eye

**Decision.** Project accents are `#d95926 / #199e70 / #9085e9`, validated with
the data-viz palette validator against this app's actual chart surface
(`#14141a`): lightness band, chroma floor, all-pairs CVD separation (worst ΔE
9.4), normal-vision separation (worst ΔE 24.6) and 3:1 contrast all pass. The
above/below-median diverging pair passes all-pairs at ΔE 25.7.

Status colours sit outside that categorical system and deliberately fail its
checks — so every status badge ships an icon **and** a text label, and colour
never carries meaning alone.

**Consequences.** New project accents must be re-validated, not just picked.

---

## 2026-09-10 · Idempotency is a database constraint

**Decision.** `PublishJob.idempotencyKey` is unique per `PostPlatform`. The
runner refuses any destination already `PUBLISHED`, and claims a job with a
conditional update so a second worker holding the same id does nothing.

**Rationale.** "Never publish twice" is the one guarantee that must not depend on
application discipline or on Redis being healthy.

**Consequences.** Re-publishing deliberately requires creating a new post, which
is the correct friction.

---

## 2026-09-10 · Postgres is truth, Redis is delivery

**Decision.** Every queued job has a row. `sweepDueJobs` reconciles the two every
60 seconds; a missing Redis job is re-added and a stale delayed one is promoted.

**Rationale.** Losing Redis should delay work, never lose it, and never
double-publish it.

**Consequences.** Two places describe the same job. The sweeper is the thing that
keeps them honest and is worth keeping tested.

---

## 2026-09-10 · BullMQ job ids are built by one helper

**Context.** BullMQ rejects a custom job id containing `:` — it uses that as its
own Redis key separator. Interpolated ids like `analyze:${assetId}` therefore
failed at `add()`, and the failure was invisible because the caller had a
fallback path.

**Decision.** All custom ids go through `queueJobId(...parts)`, which joins with
hyphens and strips colons. A unit test asserts the output never contains one.

**Consequences.** None, beyond remembering to use it.

---

## 2026-09-10 · Comparative analytics pin every post to one age window

**Context.** Reading each post at its most mature snapshot is right for display
and wrong for comparison: a 4-day-old post is read at 7d while a 40-day-old post
is read at 30d, so recent posts look systematically worse. Every project appeared
to be declining.

**Decision.** `loadPostFacts({ window })` pins the read to one window and skips
posts that have not reached it. Momentum uses `24h`, the earliest window every
published post attains.

**Consequences.** Momentum ignores posts under a day old, and says so.

---

## 2026-09-10 · The proxy does not bounce signed-in users away from /login

**Context.** The proxy checks the cookie's HMAC only — no database round trip. It
cannot distinguish a live session from a well-formed cookie whose session has
expired, been revoked, or vanished with the database. Redirecting on that check
sent such requests to the console, which redirected them back: an infinite loop
with no way out except clearing cookies.

**Decision.** Public paths always render. The login page performs the
authoritative `getCurrentUser()` check and redirects only on a real session.

**Consequences.** One extra query on the login page, which is not a hot path.

---

## 2026-09-10 · Tests use a separate database, and verify it at runtime

**Context.** The first version pointed tests at a `?schema=contentos_test`
connection string. Prisma's CLI honours that parameter — migrations really did
land in that schema — but the `pg` driver adapter ignores it, so the client
talked to `public`. The suite looked isolated while truncating the development
database on every run.

**Decision.** Tests target a separate **database** (`<db>_test`), created
automatically, which both the CLI and the driver honour. `resetDatabase` asks the
server `select current_database()` and refuses to truncate anything whose name
does not end in `_test`.

**Rationale.** The guard checks what is actually true at runtime rather than what
the configuration claims. That is the check that would have caught the original
bug immediately.

**Consequences.** Slightly slower first run while the database is created.

---

## 2026-09-10 · Trends come from our own history, and say so

**Decision.** No external trend API. The Trends page reports movement in our own
hashtags against our own earlier results, with `source = local-history` on every
row and a header explaining exactly that.

**Alternatives.** Scraping trending pages; shipping plausible-looking fake data.

**Rationale.** Scraping is out of scope by the brief's own rules, and fabricated
trend data would poison the one thing this system is for. Reporting a real, small
signal honestly beats reporting a large invented one.

**Consequences.** The page is less impressive than a competitor's trend feed, and
is not lying.

---

## 2026-09-10 · Accounts seed as DISCONNECTED

**Decision.** The demo seed does not pretend accounts are connected.

**Rationale.** A connected account means a real stored browser session, which
cannot exist without a human signing in. Showing "Connected" would be the first
lie the interface tells, and the whole product rests on its numbers being
trustworthy.

**Consequences.** The Accounts screen looks emptier on first run. Simulated
publishing works regardless, which is the point.
