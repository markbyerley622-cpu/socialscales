# AI progress

Resume point for a fresh session. Read this plus `docs/DECISIONS.md` and the
diff; the conversation is not needed.

**Last updated:** 2026-09-10 — intelligence programme phase 6 (creative variants)

---

## Objective

Build CONTENT OS: an internal console for testing several product ideas at once
by publishing short-form content for each, measuring what happens, and letting
that history drive the next round of content.

The system has since been extended into an **AI SMMA content intelligence OS**:
the same pipeline, closed into a loop that learns from what it published.

### The original build

- **Build phase 1 (done):** the whole pipeline, end to end, against a publish
  simulator.
- **Build phase 2 (done):** everything required to publish to a *real* TikTok
  test account, and honest reporting of what remains unproven. Still blocked on a
  human sign-in — see below.

### The intelligence programme

Twelve phases, each with its own verification gate. Numbering here is independent
of the build phases above.

| # | Phase | State |
|---|---|---|
| 1 | Foundation: workspace, brand, objectives, audiences | done — `90f4dbe` |
| 1a | Account vs global/external evidence separation | done — `90f4dbe` |
| 2 | AI orchestration boundary | done — `abaf924` |
| 3 | Strategy engine | done — `33dc642` |
| 4 | Content director | done — `92ecdf8` |
| 5 | Asset ingestion + analysis | done — `295ce2d` |
| 6 | Creative variants | **done — this pass** |
| 7 | Rendering | next |
| 8 | Distribution | not started |
| 9 | Analytics | not started |
| 10 | Intelligence | not started |
| 11 | Learning + experiments | not started |
| 12 | Hardening | not started |

---

## Intelligence phase 2: AI orchestration

**One line:** every model interaction now goes through a single boundary that
records what was asked, who answered, whether the answer validated, what it cost
and how long it took — and rule-based answers are labelled as rule-based, never as
model output.

- `runAiOperation()` in `src/server/ai/orchestration/run.ts` is the only place a
  model is called. Two tests enforce it by scanning `src/**` for
  `@anthropic-ai/sdk` imports and `ANTHROPIC_API_KEY` reads.
- Prompts are registered and versioned. The registry refuses a duplicate
  name+version, so changing wording without bumping the version fails at import.
- Every prompt ships a `deterministic()` implementation validated by the same
  schema, so the system works fully with no API key.
- The Anthropic provider is implemented and **inactive** until
  `ANTHROPIC_API_KEY` is set. `AI_MODEL_PROVIDER` controls the policy:
  `auto` (model if available, else rules), `deterministic` (never a model),
  `anthropic` (model or fail, never a silent substitution).
- Invalid output is repaired, not accepted. `refine()` extends that to rules a
  schema cannot express — a brand's banned phrases are corrected by a repair turn
  rather than found in the approval queue.
- Every attempt is billed in `AIUsageLog`, including repairs, including failures.

**What is not proven:** no request has reached the Anthropic API, because no key
is configured. The prompts, the schemas and the repair loop are exercised against
a stub provider and against the deterministic provider. The first real call may
find prompt wording that needs work; the validation and repair machinery is what
makes that recoverable rather than silent.

---

## Intelligence phase 3: the strategy engine

**One line:** a brand now gets an immutable, versioned strategy assembled from
its own evidence and general priors, where every decision links to the evidence
behind it with the weight that decision was actually made from.

- `buildStrategyContext()` assembles everything the engine may reason from:
  brand, objectives (weights normalised at read time), audiences, pillars, the
  account's real state, and each creative dimension's options ranked by resolved
  evidence weight. It is the typed input to the prompt, so it is stored on the
  `AIJob` — a strategy can be re-derived from the picture the system had, not
  from today's data.
- `strategy-draft@1.0.0` is registered with a full deterministic implementation,
  so a strategy can be produced with no API key.
- Three honesty constraints are enforced in `refine` and tested:
  1. Cited evidence ids must exist. An invented citation is repaired, or the
     strategy is not written at all.
  2. Audiences, objectives, pillars and formats must be ones this brand has.
  3. Confidence is capped by the account's state, not by the argument's
     coherence. A cold account gets LOW however good the reasoning.
- `StrategyEvidence` links are per-decision (`hookFamilies`,
  `recommendedFormats`, `hypotheses.N`), so "why these hooks?" is answerable
  specifically rather than as one undifferentiated pile.
- Versions are immutable. A new one supersedes the old, which stays readable,
  and each stores the `accountState` it planned from.
- `/strategy` shows the plan, the per-decision basis with evidence classes kept
  separate, hypotheses marked untested where they are, risks, and the version
  history.

**What is not proven:** every strategy this system can produce today is LOW
confidence and prior-only, because nothing has been published for real. That is
the correct answer for this account's actual state, not a limitation of the
engine — it changes on its own once real results arrive.

---

## Intelligence phase 4: the content director

**One line:** the active strategy now becomes a window of concrete briefs, each
carrying the strategy decision it serves, so a published post traces back through
the plan to the evidence that argued for it.

- `ContentPlan` implements exactly one `StrategyVersion` (required FK,
  `onDelete: Restrict`). A later strategy never becomes an existing plan's
  strategy.
- `ContentBrief` is one planned piece: pillar, format, hook family, angle, key
  message, length range, objective KPI, planned time, platforms, production
  notes, and `strategyBasis` — the decision it serves.
- Every strategy hypothesis that content can test becomes an experiment brief
  with its `hypothesisIndex`. A hypothesis nobody makes content for never gets
  tested, and the plan is where that either happens or visibly does not.
- `refine` rejects: pillars/KPIs/formats/hook families the project or strategy
  does not have; an experiment brief that will not say what it tests; an angle
  that only restates its own `strategyBasis`; duplicate briefs.
- Scheduling uses the project's real schedule slots where it has them. Where it
  does not, it spreads evenly at a fixed neutral hour and records
  `cadenceSource` — it does not ship a "best time to post" table, because that
  would be a global prior dressed as an account-specific recommendation.
- `planAdherence()` reports planned mix against delivered mix. Delivered counts
  only briefs a post was actually made from; intent is not delivery.
- Skipped briefs are kept with a required reason.
- `/plan` shows the window, the planned-vs-delivered mix per format, pillar and
  hook family, each brief with the decision it serves, and the plan history.

**What is not proven:** with no API key the deterministic planner can only rotate
the strategy's choices across pillars and formats. It says so — in each brief's
angle text and in the plan's `gaps` — rather than presenting a rotation as an
idea. Real creative angles need the model, which needs a key.

---

## Intelligence phase 5: asset ingestion and analysis

**One line:** analysis and copy drafting now run through `runAiOperation`, each
leaving its own `AIJob`, and the analysis record carries what it rests on and
what it could not determine rather than only its answers.

- `analyzeAsset()` calls no model directly. It runs `asset-analysis` then
  `copy-variants` through the boundary, so a single asset produces two attributable
  jobs with their own cost, latency and prompt version.
- `AIAnalysis` gained `confidence`, `basis[]`, `unknowns[]`, `promptVersion` and
  `aiJobId`. `model` became nullable — a deterministic provider has no model, and
  writing the provider name there would be a small lie. `transcript` is null:
  nothing in this path has heard the audio.
- Nothing unvalidated is written. A provider that answers with the wrong shape
  leaves the asset `ANALYSIS_FAILED`, an `AIJob` with status `INVALID_OUTPUT`,
  the cost of the attempts it made, and no `AIAnalysis` row.
- Re-analysis appends. Existing analyses and variants are never overwritten, and
  the control variant stays the first of the first batch.
- The scorecard stays rule-based on purpose. Asking a model to score its own copy
  would produce a number that reads like a performance prediction and is not one.
- `ContentAsset.briefId` links an asset to the brief it was made for. The link is
  declared by a person, never inferred from pillar and date: attach →
  IN_PRODUCTION, analyse → READY, create a post → FULFILLED with the post id.
- Upload validation was already sound and is unchanged: magic-byte sniffing
  against a five-entry allowlist, per-kind size caps, and storage keys derived
  from the content hash so a filename cannot traverse anywhere.

**What is not proven:** with no API key the analysis still cannot see or hear the
media — it reads a filename and container facts, reports LOW confidence, and says
"what is said or shown in the media itself" under unknowns. That is the true
ceiling of the input, not a limitation of the plumbing.

---

## Intelligence phase 6: creative treatments

**One line:** a variant now carries a shootable treatment — ordered, timed beats
with shots, on-screen text and voiceover — and its claim to deliver the brief's
key message is checked against those beats rather than trusted.

- `creative-treatment@1.0.0` produces beats, a narrative structure, a hook family
  and a CTA placement, stored on `ContentVariant` with the provider, model and
  prompt version that produced them.
- `deliversKeyMessage` is validated, not accepted. If fewer than half the key
  message's content words appear anywhere in the beats, a `true` is rejected. The
  bar is low on purpose: it catches a treatment about something else entirely,
  not a paraphrase.
- An honest `false` is accepted, badged "Off brief" on the variant card, and
  listed by `offBriefVariants()`. A treatment that misses the message is
  sometimes the better content — that is an editorial call. It happening
  unnoticed is not.
- Structural rules enforced by repair: first beat starts at 0, beats do not
  overlap, total runtime fits the brief's range, the opening beat carries the
  hook rather than a title card, `null` means silence and an empty string is
  rejected, and no banned phrase or prohibited topic appears on screen or in
  voiceover.
- A rejected treatment leaves the variant exactly as it was.

**What is not proven:** the deterministic treatment is a three-beat
hook/substance/ask skeleton fitted to the brief's length. It is genuinely
shootable and its key-message claim is true by construction, but the shot
descriptions are templates. Distinct creative direction per variant needs the
model.

---

## Live TikTok status in one line

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
prisma/schema.prisma      37 models, 37 enums (7 migrations)
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
src/server/intelligence/
  weighting.ts            evidence weights; no fixed blend ratios
  evidence.ts             the only writer of EvidenceSource
  learning.ts             hypothesis -> supported lifecycle
src/server/knowledge/     global priors / external providers; cannot write
                          ACCOUNT_EVIDENCE
src/server/strategy/
  context.ts              everything the engine may reason from
  engine.ts               immutable versions + per-decision evidence links
src/server/content-director/
  context.ts              the plan window, cadence source, active strategy
  director.ts             plans, briefs, fulfilment, planned-vs-delivered
src/server/ai/orchestration/
  run.ts                  runAiOperation — THE boundary
  registry.ts             versioned prompts + hashes
  validate.ts             JSON extraction, schema validation, repair turns
  pricing.ts              price tables, priced-at-call-time
  accounting.ts           spend and latency, read from AIUsageLog
  status.ts               what the boundary is doing, for diagnostics
  providers/              deterministic · anthropic (inactive without a key)
  prompts/                asset-analysis · copy-variants · strategy-draft ·
                          content-plan · creative-treatment
worker/index.ts           6 queues, sweeper, heartbeat, reconciliation
tests/                    unit · pipeline · live-publishing · publishing-gates ·
                          queue-reschedule (Redis-backed) ·
                          evidence-weighting · ai-orchestration ·
                          strategy-engine · content-director ·
                          asset-analysis · creative-treatment
```

---

## Next concrete actions

1. **Intelligence phase 7: rendering.** Turn a treatment into a rendered cut with
   ffmpeg — burned-in text per beat, trimmed to the beat timings — so what
   publishes is what the treatment described rather than the raw upload.
2. **Publish one real TikTok post.** Blocked only on a test account and a human
   sign-in. Everything else is in place.
3. **Fix whatever selectors the live run breaks.** Expected.
4. **Confirm one real metrics read**, so at least one snapshot is
   `BROWSER_ASSISTED` rather than `SIMULATED`.
5. **Move YouTube to its Data API** — the only platform with a documented upload
   and scheduling API. Implement `publishViaApi` and flip three capability
   entries; nothing outside that adapter changes.
6. **Thumbnails.** `ContentAsset.thumbnailKey` exists and is never populated.

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

- The AI boundary is enforced by tests, not convention: `tests/ai-orchestration.test.ts`
  scans `src/**` for `@anthropic-ai/sdk` imports and `ANTHROPIC_API_KEY` reads.
- `tests/setup.ts` clears `ANTHROPIC_API_KEY` and pins `AI_MODEL_PROVIDER=deterministic`,
  so `npm test` cannot spend money even on a machine with a real key in `.env.local`.
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

### Intelligence phase 2

12. **Prisma's client accessor for `AIJob` is `prisma.aIJob`**, not `aiJob` —
    Prisma lowercases only the first character. `AIAnalysis` was already
    `aIAnalysis`, so the ugliness is at least consistent. `prisma migrate dev`
    did not regenerate the client here; `npx prisma generate` was needed before
    the new model existed on the client.
13. **The copy prompt initially banned the `#` on hashtags.** The rest of the
    system stores tags *with* it (`Hashtag.tag = "#testing"`), so the prompt was
    holding the model to a shape nothing else used, and the deterministic
    implementation failed its own schema. Found by the test, not by review.
14. **`Date.now()` in a server component fails lint** under the React compiler's
    purity rule, even in a `force-dynamic` page. Trailing-window queries take a
    day count and compute the cutoff inside the data layer (`recentAiSpend`).

### Intelligence phase 3

15. **`ContentPillar` had no `description` on the seeded dev projects and no
    objectives or audiences at all.** The strategy engine has to work in that
    state — it is the honest cold-start case — so the deterministic
    implementation returns `null` for audience and objective rather than
    inventing a plausible one. The dev render exercised exactly this path.
16. **MSYS path mangling** rewrote a `/strategy` argument into
    `C:/Program Files/Git/strategy` when passed to a script from Git Bash. Use
    `MSYS_NO_PATHCONV=1` for any argument that is a URL path.

### Intelligence phase 4

17. **A schema minimum fired before the rule it was meant to test.** A brief's
    `strategyBasis` of `"hypotheses.0"` is 12 characters, and copying it into
    `angle` failed the 20-character floor before the "angle must not restate its
    basis" check ran. Correct ordering — structure before semantics — but the
    test had to pick a longer basis to reach the rule it was asserting on.

### Intelligence phase 5

18. **`process.env` changes do not reach `env`.** A test tried to force the AI
    boundary into an unavailable state by setting `AI_MODEL_PROVIDER` at runtime;
    `src/env.ts` reads process.env once at module load, so it had no effect and
    the test passed for the wrong reason. `analyzeAsset` now takes the same
    `provider` test seam the strategy engine and content director already expose.
19. **`createPost` returns `postId`, not a Post.** Worth knowing before writing
    `post.id` and getting `undefined` compared against a real value.
