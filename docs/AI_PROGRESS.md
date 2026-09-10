# AI progress

Resume point for a fresh session. Read this plus `docs/DECISIONS.md` and the
diff; the conversation is not needed.

**Last updated:** 2026-09-10 — phase 2 (TikTok live readiness)

---

## Objective

Build CONTENT OS: an internal console for testing several product ideas at once
by publishing short-form content for each, measuring what happens, and letting
that history drive the next round of content.

- **Phase 1 (done):** the whole pipeline, end to end, against a publish simulator.
- **Phase 2 (this pass):** everything required to publish to a *real* TikTok test
  account, and honest reporting of what remains unproven.

---

## Phase 2 status in one line

Every gate, guarantee and diagnostic around live TikTok publishing is built and
verified. **No real TikTok post has been published**, because that requires a
test account and a human sign-in, which this system deliberately cannot do for
itself.

---

## What is proven, with evidence

- **Live publishing is gated on a verified connection.** With
  `ENABLE_LIVE_PUBLISHING=1` and accounts DISCONNECTED, the running worker took
  two due jobs off the queue and BLOCKED both at `PREFLIGHT` with category
  `BLOCKED_DISCONNECTED` — no attempts consumed, nothing published, job status
  `BLOCKED` and destination back to `PENDING`.
- **Session persistence.** A dedicated automation profile survives a full browser
  process restart; a profile deleted outright is rebuilt from the encrypted copy
  in Postgres. Verified for both cookies and localStorage.
- **Idempotency under real concurrency.** Six worker processes were accidentally
  left running against the same queues during testing. Every job still produced
  exactly one publication and exactly one attempt row.
- **Observability.** Each attempt emits one structured line carrying jobId,
  postPlatformId, postId, attemptNo, account, platform, adapterMode, stage,
  event, result and normalised category — and no credentials.
- **The console reports the worker's real mode**, not its own configuration
  (see bug 8 below). Verified by running the worker live with the web app
  configured for simulation: the banner read LIVE and named the disagreement.
- **121 tests**, stable across five consecutive runs.

## What is NOT proven — the honest boundary

**No real TikTok publication has occurred.** Everything downstream of "TikTok
receives the request" is unverified: the selectors, the upload flow, challenge
detection, content-list verification, and the analytics read have only ever run
against the simulator.

TikTok cannot honestly be marked live-capable yet. It is *live-ready*.

---

## Authentication method

Browser-assisted; no credentials pass through this system.

A headed Chromium opens in a **dedicated automation profile** at
`storage/browser-profiles/<accountId>`. `assertDedicatedProfile` refuses to
launch against anything outside that root, or anything resembling a real
Chrome/Edge/Firefox profile. The operator signs in by hand. Only when a probe
returns `AUTHENTICATED` is the storageState encrypted (AES-256-GCM) into Postgres
and the account marked CONNECTED.

`statusForProbe` is the entire policy, and exactly one state justifies CONNECTED:

| Probe state | Account status |
|---|---|
| AUTHENTICATED | CONNECTED |
| CHALLENGE | CHALLENGE |
| UNAUTHENTICATED | NEEDS_REAUTH |
| UNKNOWN | ERROR |

Two layers hold the session: the persistent profile (which keeps device storage
platforms actually bind to) and the encrypted storageState in Postgres (the
authoritative, portable copy that can rebuild a lost profile).

## Adapter mode

TikTok is `BROWSER_ASSISTED` for every operation. Its Content Posting API needs a
per-account approved developer application, which does not exist here. The mode
that produced a publication is now recorded per destination and per attempt
(`adapterMode`), so provenance is never inferred from current configuration.

## Selector changes

Every TikTok target moved from a flat string list to ordered candidates resolved
by `src/server/platforms/dom.ts`, preferring semantic role and accessible name,
then TikTok's own `data-e2e` attributes, then structure, then text. Generated
class names, DOM depth and positional selectors are not used. When nothing
matches, the error names every candidate tried, the target description and the
query-stripped URL.

**Still unvalidated against real TikTok.** Expect to fix them on first contact;
the diagnostics exist for exactly that loop.

## Metrics availability

TikTok exposes no metrics API without an approved developer application. What is
implemented reads the operator's **own** post analytics from their own
authenticated Studio session — the account owner's own data, not third-party or
private values. Metrics Studio does not display are left **absent** rather than
defaulted to zero. A live read also requires the account CONNECTED with an ACTIVE
session; anything less falls back to the simulator and is stamped `SIMULATED`.

**Boundary:** unverified until a real post exists.

## Failure modes now modelled

`AUTH_SESSION`, `SELECTOR_DRIFT`, `TRANSIENT`, `PLATFORM_REJECTED`,
`MEDIA_REJECTED`, `HUMAN_ACTION_REQUIRED`, `BLOCKED_DISCONNECTED`, `UNKNOWN`.

Only `TRANSIENT` and `UNKNOWN` are retried. `PLATFORM_REJECTED` is deliberately
never retried: it means TikTok accepted the submission but the post could not be
confirmed, so a blind retry risks a duplicate post.

---

## Handing off the live run

The sign-in is the one step this system cannot do for itself, by design.

1. Create a throwaway TikTok account for testing.
2. `npm run db:up`; then `npm run dev`, and in another terminal
   `ENABLE_LIVE_PUBLISHING=1 npm run worker`.
3. Accounts → the TikTok row → **Connect**. A Chromium window opens in the
   dedicated automation profile. Sign in there. The account becomes CONNECTED
   only once a probe confirms an authenticated Studio session.
4. Upload a short 9:16 MP4, approve it, schedule it a few minutes out.
5. Watch `scratch/worker.log` and the Publish queue.

Expect the first live run to fail on selectors. The failure names every candidate
it tried and keeps a screenshot.

---

## Verification, as last run

```
tsc --noEmit          0 errors
eslint .              0 problems
vitest run            121 passed (121)   [stable across 5 consecutive runs]
next build            succeeded
browser walk          all routes, 0 runtime errors
live-gate proof       2 jobs BLOCKED at PREFLIGHT with live mode on
```

---

## Where things are

```
prisma/schema.prisma      24 models, 25 enums
src/server/platforms/
  types.ts                capability model, AdapterFailure, PublicationEvidence
  dom.ts                  candidate resolution + drift diagnostics
  tiktok.ts               probe / publish / verify / metrics
src/server/automation/
  browser.ts              dedicated profiles + encrypted session restore
  connect-account.ts      connect / verify / disconnect
  publish-runner.ts       gates, stages, classification, reconciliation
src/server/jobs/
  worker-status.ts        worker heartbeat + effective publishing mode
worker/index.ts           6 queues, sweeper, heartbeat, reconciliation
tests/                    unit · pipeline · live-publishing · publishing-gates ·
                          queue-reschedule (Redis-backed)
```

---

## Next concrete actions

1. **Publish one real TikTok post.** Blocked only on a test account and a human
   sign-in. Everything else is in place.
2. **Fix whatever selectors the live run breaks.** Expected.
3. **Confirm one real metrics read**, so at least one snapshot is
   `BROWSER_ASSISTED` rather than `SIMULATED`.
4. **Move YouTube to its Data API** — the only platform with a documented upload
   and scheduling API. Implement `publishViaApi` and flip three capability
   entries; nothing outside that adapter changes.
5. **Thumbnails.** `ContentAsset.thumbnailKey` exists and is never populated.

---

## Bugs found by real validation

Each was caught by driving the real UI, the real queue or a real browser — not by
types or tests.

### Phase 1

1. **`buttonClass` behind the client boundary** — 500 on every page using it.
2. **BullMQ rejects `:` in custom job ids** — analysis, connect, retry and sweep
   enqueues failed silently behind fallbacks.
3. **Rescheduling never moved the queued job** — BullMQ ignores a duplicate `add`.
4. **Momentum was age-biased** — every project looked like it was declining.
5. **Infinite `/` ↔ `/login` redirect** for a valid-HMAC cookie with no session.
6. **The test suite truncated the development database** — Prisma's `?schema=` is
   honoured by the CLI but ignored by the driver adapter.
7. **`tkhd` offsets off by four bytes** in the MP4 probe.

### Phase 2

8. **The console reported the wrong publishing mode.** The banner read the web
   process's own `ENABLE_LIVE_PUBLISHING`, but the *worker* publishes and is a
   separate process with its own environment. A console showing "Simulation
   mode" while the worker published for real is a real safety hole. The worker
   now reports its effective mode to `WorkerStatus`, the console reads that, and
   disagreement is called out explicitly. Reproduced and verified.
9. **The test suite was flaky at ~1 run in 8.** The simulator failed a fixed
   fraction of first attempts, deterministic per destination id — but ids are
   random per run, making it effectively random. Now `SIMULATED_FAILURE_RATE`,
   pinned to 0 in tests, with the retry path pinning it to 1.
10. **A simulator failure classified UNKNOWN instead of TRANSIENT**, because the
    fallback matched "timeout" but the message said "timed out". The simulator
    now raises a classified `AdapterFailure` like a real adapter, and the
    fallback covers both phrasings.
11. **Turbopack served a stale generated Prisma client**, so a newly added enum
    value failed at runtime with "Expected JobStatus" while both the database and
    the generated types had it. `rm -rf .next` after `prisma generate` clears it.

---

## Things worth not forgetting

- The seed is deterministic (mulberry32) and also obliterates this app's own
  BullMQ queues, so a re-seed leaves no orphan jobs.
- `npm run db:seed` truncates `UserSession`, so it signs you out.
- Tests use a separate `<db>_test` **database**; `resetDatabase` asks the server
  `select current_database()` and refuses anything not ending in `_test`.
- Redis-backed tests use `QUEUE_PREFIX=bull-test` so they cannot touch
  development jobs.
- Next 16 specifics that bit: async request APIs, `middleware` → `proxy`,
  `revalidateTag` needs a `cacheLife` argument, and the Turbopack dev cache
  survives restarts. The bundled docs in `node_modules/next/dist/docs/` are the
  authority.
- Killing background processes on Windows: `pkill -f` does not match Node's
  command lines reliably. Use PowerShell `Get-CimInstance Win32_Process` and
  filter on `CommandLine`, or `taskkill /PID`. Stray workers caused a confusing
  hour of debugging.
