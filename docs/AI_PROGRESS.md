# AI progress

Resume point for a fresh session. Read this plus `docs/DECISIONS.md` and the
diff; the conversation is not needed.

**Last updated:** 2026-09-10

---

## Objective

Build CONTENT OS: an internal console for testing several product ideas at once
by publishing short-form content for each, measuring what happens, and letting
that history drive the next round of content.

Agreed scope for this pass (chosen with the user up front):

- Postgres + Redis via Docker Compose, BullMQ for queues
- Heuristic AI provider only, behind a swappable interface
- Single-operator credential auth
- **Phase 1 end to end**, plus a real dashboard computing over seeded history

---

## Acceptance criteria

| # | Criterion | State |
|---|---|---|
| 1 | Upload → AI metadata → review → approve → schedule → publish → logged | **Done**, driven through the browser |
| 2 | Three isolated projects with their own brand, accounts, schedule, library | Done |
| 3 | Relational schema, real FKs and indexes, no JSON-blob database | Done — 23 tables |
| 4 | Platform adapters with declared capabilities; scheduler stays platform-agnostic | Done |
| 5 | Playwright worker, encrypted sessions, step logs, bounded retries | Done; live publishing off by default |
| 6 | Append-only analytics, never overwritten | Done |
| 7 | Evidence-based recommendations, no invented viral score | Done |
| 8 | Real tests, no production account required | Done — 79 passing |
| 9 | Premium dark console UI | Done |
| 10 | Docs: setup, env, API-vs-browser matrix, limitations | Done |

---

## Verification, as last run

```
tsc --noEmit          0 errors
eslint .              0 problems
vitest run            79 passed (79)   [stable across 3 consecutive runs]
next build            succeeded, 19 routes, no warnings
browser walk          12 routes, 0 runtime errors, 0 failed requests
```

End-to-end proven in the browser, not just asserted:

- signed in as the seeded operator
- uploaded an MP4 → probed 22s / 9:16 / audio → status `ANALYZED`
- approved a pending post → 2 `PublishJob` rows queued, 2 delayed jobs in Redis
- ran a job from the queue UI → published
- retried a failed job → `FAILED` 3 → 2, `QUEUED` 2 → 3
- started the worker → it consumed a promoted job and published it
- ran the test suite → development data unchanged afterwards

---

## Bugs found and fixed during verification

Each was caught by driving the real UI or the real queue, not by types or tests.

1. **`buttonClass` behind the client boundary.** Exported from a `"use client"`
   module and called by server components → runtime 500 on every page using it.
   Moved to `button-styles.ts`.
2. **BullMQ rejects `:` in custom job ids.** Analysis, connect, retry and sweep
   enqueues all failed silently behind fallbacks. Added `queueJobId()` plus a
   regression test.
3. **Rescheduling never moved the queued job.** BullMQ ignores a duplicate `add`,
   so a changed time did not reach Redis. `addToQueue` now removes a
   not-yet-running duplicate first; the sweeper promotes an overdue delayed job.
4. **Momentum was age-biased.** Comparing each post at its most mature window made
   every project look like it was declining. Comparative reads now pin one window.
5. **Infinite `/` ↔ `/login` redirect** for a cookie with a valid HMAC but no live
   session. The proxy no longer bounces on its cheap check.
6. **The test suite truncated the development database.** Prisma's `?schema=` is
   honoured by the CLI but ignored by the driver adapter. Tests now use a separate
   database and `resetDatabase` verifies `current_database()` ends in `_test`.
7. **`tkhd` dimension offsets off by four bytes** in the MP4 probe (width sits at
   76/88, not 80/92).

---

## Where things are

```
prisma/schema.prisma      23 models, 22 enums
prisma/seed.ts            3 projects · 22 assets · 147 variants · 87 posts
                          139 published destinations · 460 snapshots
prisma/sample-media.ts    builds genuinely parseable MP4/PNG for the seed
src/server/               the layer map is in the README
src/app/(app)/            12 console screens
worker/index.ts           6 queues + sweeper + session pruning
tests/                    unit.test.ts (pure) · pipeline.test.ts (database)
```

---

## Next concrete actions

In the order they are worth doing.

1. **Verify one live publish.** Set `ENABLE_LIVE_PUBLISHING=1`, connect one TikTok
   account, publish one real post, and fix whatever the selectors get wrong. This
   is the single largest unverified area.
2. **Implement `collectMetrics` for one platform** so at least one metric source
   is `BROWSER_ASSISTED` rather than `SIMULATED`, and the analytics stop being
   entirely synthetic.
3. **Move YouTube to its Data API.** It is the only platform with a documented
   upload + scheduling API. Implement `publishViaApi` and flip three capability
   entries; nothing outside the adapter changes.
4. **Phase 3 proper.** The learning engine and recommendations exist; experiments
   currently compute their verdict live rather than being managed objects with a
   start/stop lifecycle.
5. **Thumbnails.** `ContentAsset.thumbnailKey` exists and is never populated —
   the library shows a tinted panel for videos whose first frame will not decode.
6. **Per-project timezone correctness** in scheduling (see README limitation 7).

---

## Things worth not forgetting

- The seed is deterministic (mulberry32). Re-running gives the same database,
  which keeps screenshots and any future snapshot tests stable.
- `npm run db:seed` also obliterates this app's own BullMQ queues, so a re-seed
  does not leave the worker chasing rows that no longer exist.
- The simulator fails ~1 in 8 first attempts, deterministically per post. That is
  intentional: it keeps the retry path and the failure UI genuinely reachable.
- Next 16 specifics that bit: async request APIs, `middleware` → `proxy`,
  `revalidateTag` needs a `cacheLife` argument. The bundled docs in
  `node_modules/next/dist/docs/` are the authority, not memory.
